import type { Context } from "telegraf";

import { buildCookie, uploadImage } from "../services/acfun";
import { getAcfunToken, hasSeen, loadCollection, markSeen } from "../services/collection";
import { collectImage, flushIfReady, QUOTA } from "../services/poster";
import { logger } from "../utils/logger";
import { formatBeijingTime } from "../utils/time";
import { escapeMarkdown, formatBytes, imageLink, sendWithFallback } from "../utils/markdown";
import type { AcfunImage } from "../types/acfun";

export interface PhotoDeps {
	/** 状态 KV；同时也是 acPasstoken 的来源（同一个 cloud-mail namespace） */
	stateKv: KVNamespace;
	/** 凭证覆盖（本地调试用） */
	cookieOverride?: string;
	/** 白名单 chat id；留空表示不限制 */
	ownerChatId?: number;
}

/** 单张图上限：超过 1 MiB 会变成多分片，子请求数上升。 */
const MAX_BYTES = 1048576;

/** 收到即回执，但同一媒体组（相册）只回一条。isolate 级缓存，够用且零成本。 */
const albumReceipted = new Set<string>();

const describe = (error: any): string => String(error?.message ?? error);

type PhotoSize = {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
};

/**
 * 从消息里取出要处理的那张图。
 *
 * 两种来源都收：
 *  - `photo`    —— Telegram 的「照片」，被压缩过，数组按尺寸升序、取最后一档最大
 *  - `document` —— 以「文件」方式发出的图（转发时很常见），保留原图，没有宽高需要解析
 *
 * 只放行图片 MIME；文档里的原始宽高 Telegram 不给，所以从 JPEG 文件头读。
 */
function pickImage(
	message: any,
): { photo: PhotoSize; isDocument: boolean; mediaGroupId?: string } | null {
	if (message.photo?.length) {
		return {
			photo: message.photo[message.photo.length - 1] as PhotoSize,
			isDocument: false,
			mediaGroupId: message.media_group_id,
		};
	}
	const doc = message.document;
	if (doc && typeof doc.mime_type === "string" && doc.mime_type.startsWith("image/")) {
		return {
			photo: {
				file_id: doc.file_id,
				file_unique_id: doc.file_unique_id,
				width: 0,
				height: 0,
				file_size: doc.file_size,
			},
			isDocument: true,
			mediaGroupId: message.media_group_id,
		};
	}
	return null;
}

/**
 * 从 JPEG 文件头读宽高（不解码像素）。
 *
 * Telegram 的 `photo` 会直接给出宽高，所以只有走 `document` 路径时才需要这个。
 * 注意 EXIF orientation 5~8 表示需要交换宽高，这里按 APP1 里的 0x0112 标签处理。
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
	let orientation = 1;
	let i = 2; // 跳过 SOI (FF D8)
	while (i < bytes.length - 1) {
		if (bytes[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = bytes[i + 1];
		// SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const height = (bytes[i + 5] << 8) | bytes[i + 6];
			const width = (bytes[i + 7] << 8) | bytes[i + 8];
			const swap = orientation >= 5 && orientation <= 8;
			return swap ? { width: height, height: width } : { width, height };
		}
		// EXIF 在 APP1 里找 orientation
		if (marker === 0xe1) {
			const segEnd = i + 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
			const o = findExifOrientation(bytes, i + 4, segEnd);
			if (o) orientation = o;
		}
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		if (len <= 0) break;
		i += 2 + len;
	}
	return null;
}

/** 从 APP1 段里找 TIFF 头的 0x0112 (Orientation) 标签。 */
function findExifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
	// "Exif\0\0"
	if (
		bytes[start] !== 0x45 || bytes[start + 1] !== 0x78 ||
		bytes[start + 2] !== 0x69 || bytes[start + 3] !== 0x66
	) {
		return null;
	}
	const tiff = start + 6;
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const read16 = (p: number) => (little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
	const read32 = (p: number) =>
		little
			? bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)
			: (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
	const ifd0 = tiff + read32(tiff + 4);
	const count = read16(ifd0);
	for (let e = 0; e < count; e++) {
		const entry = ifd0 + 2 + e * 12;
		if (entry + 12 > end) break;
		if (read16(entry) === 0x0112) return read16(entry + 8);
	}
	return null;
}

/** PNG：宽高固定在 IHDR 里（偏移 16 起，各 4 字节大端）。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24) return null;
	if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
	const be32 = (p: number) =>
		((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
	return { width: be32(16), height: be32(20) };
}

/** WebP：三种子格式（VP8 / VP8L / VP8X）的宽高位置各不同。 */
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 30) return null;
	const tag = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
	if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
	const fmt = tag(12);
	const u16 = (p: number) => bytes[p] | (bytes[p + 1] << 8);
	const u24 = (p: number) => bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);

	if (fmt === "VP8 ") {
		// 有损：帧头里 0x9d012a 之后是 14 位宽高
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
		return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
	}
	if (fmt === "VP8L") {
		// 无损：14 位宽高打包在 4 字节里
		const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (fmt === "VP8X") {
		// 扩展：24 位宽高减一
		return { width: u24(24) + 1, height: u24(27) + 1 };
	}
	return null;
}

/**
 * 从图片字节里认出格式与宽高。
 *
 * Telegram 的「照片」会直接给宽高，所以只有走「文件」路径时才需要这个。
 * 支持 JPEG / PNG / WebP —— 转发来的梗图常见这三种。
 */
export function imageSize(
	bytes: Uint8Array,
): { width: number; height: number; ext: string; kind: string } | null {
	if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		const s = jpegSize(bytes);
		return s ? { ...s, ext: "jpg", kind: "JPEG" } : null;
	}
	if (bytes.length > 12 && bytes[0] === 0x89 && bytes[1] === 0x50) {
		const s = pngSize(bytes);
		return s ? { ...s, ext: "png", kind: "PNG" } : null;
	}
	if (bytes.length > 16 && bytes[8] === 0x57 && bytes[9] === 0x45) {
		const s = webpSize(bytes);
		return s ? { ...s, ext: "webp", kind: "WebP" } : null;
	}
	return null;
}

/**
 * 处理一条带照片的消息 —— "一条进，两条出"（凑满 9 张时是三条）。
 *
 * 流程（全部在这一次 Worker 调用内串行完成，约 3~5 秒）：
 *   1. 先回执 `📥 收到，正在上传…` —— 立刻发，此时这一张还没开始传
 *   2. 下载 → 上传 AcFun → 落库
 *   3. 回执 `✅ 第 N 张已存好 · X/9`
 *   4. 若凑满 9 张，就地发动态并回第 3 条（`✅ 已发布 9 图动态` + 链接）
 *
 * 为什么全程串行、不用后台任务：
 *  - Telegraf 的 `Context` 没有 `waitUntil`（已核对 telegraf@4.16.3 的 typings 与源码），
 *    而 Workers 在事件循环排空后会取消未完成的后台任务；
 *  - 串行总耗时约 5 秒，远小于 Telegram webhook 的 60 秒超时，也远低于 50 个子请求上限
 *    （一张图 5 个 + 发帖 1 个 = 最多 7 个）。
 * 所以自己造一个自 fetch 的异步管道只增加故障面，不带来收益。
 */
export async function handlePhoto(ctx: Context, deps: PhotoDeps): Promise<void> {
	const message = ctx.message;
	if (!message) return;

	const picked = pickImage(message);
	if (!picked) return;
	const { photo, isDocument, mediaGroupId } = picked;

	const chatId = message.chat.id;
	// 统一走「先 Markdown、失败退纯文本」，避免任何一条消息因解析问题整条丢失
	const send = (text: string) =>
		sendWithFallback((t, parseMode, options) => {
			const extra: any = {};
			if (parseMode) extra.parse_mode = parseMode;
			if (options?.disablePreview) extra.link_preview_options = { is_disabled: true };
			return ctx.telegram.sendMessage(chatId, t, extra);
		}, text);

	// 白名单之外的人：完全不回应。
	// 不回任何消息是刻意的 —— 让外人分不清这个 Bot 到底存不存在，也省掉被搭话的可能。
	if (deps.ownerChatId && chatId !== deps.ownerChatId) {
		logger.warn("非白名单 chat 发来图片，已静默丢弃", { chatId });
		return;
	}

	// 幂等去重：Telegram 重投同一条更新时不重复上传
	if (await hasSeen(deps.stateKv, photo.file_unique_id)) {
		logger.info("该照片已处理过，跳过", { fileUniqueId: photo.file_unique_id });
		return;
	}

	// ① 立刻回执。相册（media_group）只回一条，避免刷屏。
	//    ⚠️ 但这只是"收到了"——真正开始上传前还要过体积/格式校验，
	//    所以在下载并验证通过后才会发（见下面），免得先发「正在上传」再报错。
	const albumKey = mediaGroupId !== undefined ? String(mediaGroupId) : null;
	const shouldReceipt = !albumKey || !albumReceipted.has(albumKey);
	if (albumKey) {
		albumReceipted.add(albumKey);
		if (albumReceipted.size > 200) albumReceipted.clear();
	}

	// Telegram 元数据里就给了体积，超限的直接跳过，省掉一次下载
	if (photo.file_size && photo.file_size > MAX_BYTES) {
		await send(oversizeHint(photo.file_size));
		return;
	}

	// 先标记已见，避免上传中途重投造成重复上传
	await markSeen(deps.stateKv, photo.file_unique_id);

	// 回执消息的 message_id。拿到它之后，上传结果就用「编辑这条消息」呈现，
	// 而不是再发一条 —— 见文件头的交互说明。
	let receiptId: number | null = null;

	/**
	 * 发回执并记下 message_id（失败时返回 null，不抛）。
	 *
	 * 回执是纯静态文本、不含任何链接，所以**故意不带 parse_mode** ——
	 * 没必要为它承担 Markdown 解析失败的风险，它也绝不会因此整条丢失。
	 * 后面的结果消息因为有超链接才需要 Markdown（并走 sendWithFallback 兜底）。
	 */
	const sendTracked = async (text: string): Promise<number | null> => {
		try {
			const sent = await ctx.telegram.sendMessage(chatId, text);
			return sent?.message_id ?? null;
		} catch (error: any) {
			logger.error("发送消息失败", { message: error?.message });
			return null;
		}
	};

	try {
		// ② 下载
		const link = await ctx.telegram.getFileLink(photo.file_id);
		const res = await fetch(link.toString());
		if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());

		if (bytes.length > MAX_BYTES) {
			await send(oversizeHint(bytes.length));
			return;
		}

		// ③ 尺寸。
		//    `photo` 路径 Telegram 直接给了宽高；`document` 路径（转发常见）没有，
		//    只能从文件头读，顺便认出真实格式 —— 扩展名会影响 AcFun 返回的直链后缀。
		let width = photo.width;
		let height = photo.height;
		let ext = "jpg";
		if (isDocument || !width || !height) {
			const size = imageSize(bytes);
			if (!size) {
				await send(
					"⚠️ 认不出这个图片格式（支持 JPEG / PNG / WebP），AcFun 的接口需要宽高。\n" +
						"可以改用「照片」方式发送，或先转成 JPEG。",
				);
				return;
			}
			({ width, height } = size);
			ext = size.ext;
		}

		if (shouldReceipt) {
			receiptId = await sendTracked("📥 收到，正在上传…");
		}

		// ④ 上传 AcFun，换持久直链（5 个子请求）
		const cookie = buildCookie(
			await getAcfunToken(deps.stateKv, deps.cookieOverride),
		);
		const uploaded = await uploadImage(cookie, bytes, `${photo.file_unique_id}.${ext}`);

		const image: AcfunImage = {
			url: uploaded.url,
			width,
			height,
			size: bytes.length,
			fileId: photo.file_unique_id,
			at: Date.now(),
		};

		// ⑤ 落库
		const collection = await collectImage(deps.stateKv, chatId, image);
		const count = collection.images.length;

		// ⑥ 把回执「就地改写」成结果，而不是再发一条。
		//    格式固定为：✅ [上传成功](原图) · 大小（n / 9）
		//    「上传成功」本身是超链接，所以不再额外回显图片或直链。
		const result =
			`✅ ${imageLink(uploaded.url, "上传成功")} · ` +
			`${formatBytes(bytes.length)}（${count} / ${QUOTA}）`;

		if (receiptId !== null) {
			try {
				await ctx.telegram.editMessageText(chatId, receiptId, undefined, result, {
					parse_mode: "Markdown",
					// 这是用户自己的梗图，弹预览既刷屏又剧透
					link_preview_options: { is_disabled: true },
				} as any);
			} catch (error: any) {
				// 编辑失败（消息太旧/已被删/内容未变）不该吞掉结果，退回发新消息
				logger.warn("编辑回执失败，改为新发一条", { message: error?.message });
				await send(result);
			}
		} else {
			await send(result);
		}

		// ⑦ 凑满 9 张 → 直接发帖。这一跳约 2.3 秒，整个请求总计约 5 秒，远低于 Telegram 的 60 秒超时
		if (count >= QUOTA) {
			logger.info("收集已满，开始发帖", { count });
			await flushIfReady({
				stateKv: deps.stateKv,
				cookieOverride: deps.cookieOverride,
				// 丢掉 sendMessage 的返回值，只要 void
				notify: async (id, text) => {
					await ctx.telegram.sendMessage(id, text, { parse_mode: "Markdown" });
				},
			});
		}
	} catch (error: any) {
		logger.error("照片处理失败", { message: error?.message, chatId });
		// 失败就撤掉去重标记，允许用户直接重发这张图
		await deps.stateKv.delete(`seen:${photo.file_unique_id}`);
		await send(`❌ 这张上传失败：${escapeMarkdown(describe(error))}\n把这张图重发一次即可。`);
	}
}

const oversizeHint = (size: number) =>
	`⚠️ 这张图 ${(size / 1024 / 1024).toFixed(2)} MB，超过 1 MiB 上限。\n` +
	`再大就会拆成多分片、推高子请求数，所以这次跳过了。请压缩后再发。`;

/**
 * /status 用：把当前收集情况整理成可读列表。
 *
 * 链接文字统一用「预览」—— 这个列表里每一条都是图，编号本身已经表达了顺序，
 * 再写「图 1 / 图 2」是冗余。点「预览」直接开原图。
 */
export async function describeCollection(kv: KVNamespace): Promise<{ text: string; images: number }> {
	const c = await loadCollection(kv);
	if (c.images.length === 0) {
		return { text: "📭 *当前没有收集中的图片。*", images: 0 };
	}

	const lines = [`📦 *已收集 ${c.images.length}/${QUOTA}*`, ""];
	c.images.forEach((im, i) => {
		lines.push(
			`${i + 1}. ${imageLink(im.url)} · ${formatBytes(im.size)} · ${formatBeijingTime(im.at)}`,
		);
	});
	if (c.images.length >= QUOTA) {
		lines.push("", "_已满 9 张，会立刻自动发布；也可以发 /post 手动触发。_");
	} else {
		lines.push("", `_还差 ${QUOTA - c.images.length} 张触发自动发布。_`);
	}
	return { text: lines.join("\n"), images: c.images.length };
}
