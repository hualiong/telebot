import type { Context } from "telegraf";

import { buildCookie, uploadImage } from "../services/acfun";
import { getAcfunToken, hasSeen, loadCollection, markSeen } from "../services/collection";
import { collectImage, flushIfReady, QUOTA } from "../services/poster";
import { logger } from "../utils/logger";
import { formatBeijingTime } from "../utils/time";
import { formatBytes, htmlBlockquote, imageLink, sendWithFallback } from "../utils/markdown";
import {
	consumeTicket,
	type RetryTicket,
	retryCallbackData,
	saveTicket,
} from "../utils/retry";
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
 * 消息发送器：一次装配，之后所有文案都走同一个出口，
 * 免得每个提示各拼一遍 `parse_mode` / 链接预览这类容易写错的参数。
 *
 * `sendText` 会返回发出的 message_id（失败返回 null），因为**首次上传**是
 * 「先发回执、再就地改写」，必须拿到这个 id；重试时消息已经存在，用不上。
 */
interface Sender {
	sendText(text: string, options?: { mode?: "Markdown" | "HTML"; link?: boolean }): Promise<number | null>;
	editText(
		messageId: number,
		text: string,
		options?: { mode?: "Markdown" | "HTML"; link?: boolean; replyMarkup?: unknown },
	): Promise<void>;
}

function makeSender(ctx: Context, chatId: number): Sender {
	const call = (text: string, options: Record<string, unknown>) =>
		(ctx.telegram.sendMessage as any)(chatId, text, options) as Promise<any>;

	const sendText: Sender["sendText"] = async (text, options = {}) => {
		let messageId: number | null = null;
		await sendWithFallback(async (t, extra) => {
			const sent = await call(t, extra);
			messageId = sent?.message_id ?? null;
		}, text, options);
		return messageId;
	};

	const editText: Sender["editText"] = async (messageId, text, options = {}) => {
		await sendWithFallback((t, extra) => {
			const payload: Record<string, unknown> = { ...extra };
			if (options.replyMarkup !== undefined) payload.reply_markup = options.replyMarkup;
			return (ctx.telegram.editMessageText as any)(chatId, messageId, undefined, t, payload);
		}, text, options);
	};

	return { sendText, editText };
}

/** 失败提示里的行动建议：首次失败让用户重发，点了重试再失败就只能再点一次。 */
const retryHint = (fresh: boolean): string =>
	fresh ? "❌ 把这张图重发一次即可。" : "❌ 再点一次上面的按钮即可重试。";

/**
 * 上传一张图的完整流程 —— 首次发送与「重试按钮」**共用这一份**。
 *
 * 抽出来是这次改动的核心：重试本质上就是「拿同一张图再跑一遍上传」，
 * 若各写一份，两条路径的校验、报错文案、落库逻辑迟早会漂移。
 *
 * 全程串行，理由见 `handlePhoto` 上方的说明。
 *
 * @param fresh 首次处理（true）还是点了重试按钮（false）。
 *              fresh 会先发回执并自行取得 message_id；重试则复用那条失败消息
 *              的 message_id（它此时正显示着报错），直接改写。
 */
async function runUpload(
	ctx: Context,
	chatId: number,
	photo: { file_id: string; file_unique_id: string; width: number; height: number },
	isDocument: boolean,
	fresh: boolean,
	receiptId: number | null,
	deps: PhotoDeps,
): Promise<void> {
	const send = makeSender(ctx, chatId);

	/** 回执的 message_id —— 拿到它之后，结果与报错都靠「编辑这条」来呈现。 */
	let targetId = receiptId;
	/** 是否已进入「上传 AcFun」这一步；回滚去重标记只该在这一步之后做。 */
	let attempted = false;

	// 这三个在 catch 里还要用来存「重试门票」，所以**必须在 try 外声明**；
	// 若留在 try 内，成功路径不会有问题，但 catch 分支会直接编译不过（或更糟：值丢失）。
	let width = photo.width;
	let height = photo.height;
	let ext = "jpg";

	try {
		// ① 下载
		const link = await ctx.telegram.getFileLink(photo.file_id);
		const res = await fetch(link.toString());
		if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());

		if (bytes.length > MAX_BYTES) {
			await send.sendText(oversizeHint(bytes.length));
			return;
		}

		// ② 尺寸。
		//    `photo` 路径 Telegram 直接给了宽高；`document` 路径（转发常见）没有，
		//    只能从文件头读，顺便认出真实格式 —— 扩展名会影响 AcFun 返回的直链后缀。
		if (isDocument || !width || !height) {
			const size = imageSize(bytes);
			if (!size) {
				await send.sendText(
					"⚠️ 认不出这个图片格式（支持 JPEG / PNG / WebP），AcFun 的接口需要宽高。\n" +
						"可以改用「照片」方式发送，或先转成 JPEG。",
				);
				return;
			}
			({ width, height } = size);
			ext = size.ext;
		}

		// ③ 回执。首次才发新消息；重试时那条消息正显示着报错，反复重发会刷屏。
		if (fresh) {
			targetId = await send.sendText("📥 收到，正在上传…");
		}

		// ④ 上传 AcFun，换持久直链（5 个子请求）
		attempted = true;
		const cookie = buildCookie(
			await getAcfunToken(deps.stateKv, deps.cookieOverride),
		);
		const uploaded = await uploadImage(cookie, bytes, `${photo.file_id}.${ext}`);

		const image: AcfunImage = {
			url: uploaded.url,
			width,
			height,
			size: bytes.length,
			fileId: photo.file_id,
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

		if (targetId !== null) {
			try {
				// 不带 reply_markup：重试成功时顺手把按钮摘掉
				await send.editText(targetId, result, { mode: "Markdown" });
			} catch (error: any) {
				// 编辑失败（消息太旧/已被删/内容未变）不该吞掉结果，退回发新消息
				logger.warn("编辑回执失败，改为新发一条", { message: error?.message });
				await send.sendText(result, { mode: "Markdown" });
			}
		} else {
			await send.sendText(result, { mode: "Markdown" });
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
		logger.error(fresh ? "照片处理失败" : "重试上传失败", {
			message: error?.message,
			rawMsg: error?.rawMsg,
			chatId,
			fresh,
		});

		// 失败就撤掉去重标记，**两条路径都要** —— 这是用户「手动兜底」的前提。
		//
		// ⚠️ 别只在首次失败时撤。重试失败后消息里写着「再点一次按钮」，
		//    但用户很可能下意识地**把图重发一遍**；若标记还在，handlePhoto 会
		//    判定「已处理过」直接静默 return，用户发出去的消息石沉大海 ——
		//    既没有回复也没有报错，是最难排查的那种「没反应」。
		//
		// 只在真正走到上传这一步之后才撤：下载失败/体积超限这类根本还没上传，
		// 撤了标记会让 Telegram 的重投有机会重新下载一遍。
		//
		// ⚠️ 键必须是 `file_unique_id`，与 handlePhoto 里 markSeen/hasSeen 完全一致；
		//    写成 file_id 会删到一个不存在的键上，静默失效。
		if (attempted) {
			await deps.stateKv.delete(`seen:${photo.file_unique_id}`);
		}

		// 报错是**编辑**而不是新发消息 —— 与成功路径一致，聊天里不会多出第二条。
		// ⚠️ 代价：Telegram 只对新消息推通知，编辑不推，所以上传失败时手机是安静的。
		//    这是刻意接受的取舍（聊天整洁优先）。
		//
		// 引用块里只放**服务端返回的原始 error_msg**（如「服务器繁忙，请稍后再试」）；
		// `getToken 失败:` 这类前缀是本项目自己拼的诊断信息，进了日志，不上屏。
		const reason = String(error?.rawMsg ?? error?.message ?? error);
		const text = `${htmlBlockquote(reason)}\n${retryHint(fresh)}`;

		// 重试按钮：任何上传失败都给，因为超时/网络抖动同样能用重试救回来。
		// callback_data 有 64 字节硬上限，所以这里只放短 token，参数存 KV（见 utils/retry）。
		let replyMarkup: unknown;
		try {
			const token = await saveTicket(deps.stateKv, {
				fileId: photo.file_id,
				fileUniqueId: photo.file_unique_id,
				// 用本轮实际探明的扩展名，重试时才能原样重建上传文件名
				ext,
				width,
				height,
				chatId,
			});
			replyMarkup = {
				inline_keyboard: [[{ text: "🔄 重试", callback_data: retryCallbackData(token) }]],
			};
		} catch (ticketError: any) {
			// 门票存不下不该让用户什么都收不到，退化成「不带按钮的报错」
			logger.error("保存重试门票失败，本次不给按钮", { message: ticketError?.message });
		}

		if (targetId !== null) {
			try {
				await send.editText(targetId, text, { mode: "HTML", replyMarkup });
			} catch (editError: any) {
				logger.warn("编辑失败消息失败，改为新发一条", { message: editError?.message });
				await send.sendText(text, { mode: "HTML" });
			}
		} else {
			await send.sendText(text, { mode: "HTML" });
		}
	}
}

/**
 * 处理一条带照片的消息 —— "一条进，一条出"（凑满 9 张时是第二条）。
 *
 * 流程（全部在这一次 Worker 调用内串行完成，约 3~5 秒）：
 *   1. 校验体积（先看元数据，必要时下载后再验）
 *   2. 发回执 `📥 收到，正在上传…`
 *   3. 下载 → 上传 AcFun → 落库
 *   4. 回执**就地改写**成结果 `✅ [上传成功](原图) · 大小（n / 9）`
 *   5. 若凑满 9 张，发一条新消息通报发帖结果
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

	// 相册（media_group）只回一条，避免刷屏
	const albumKey = mediaGroupId !== undefined ? String(mediaGroupId) : null;
	const shouldReceipt = !albumKey || !albumReceipted.has(albumKey);
	if (albumKey) {
		albumReceipted.add(albumKey);
		if (albumReceipted.size > 200) albumReceipted.clear();
	}

	// Telegram 元数据里就给了体积，超限的直接跳过，省掉一次下载。
	// 顺带说明：这里也故意不发回执 —— 回执的含义是「这张开始传了」，
	// 而超限的图根本不会开始传（见文件头的交互说明）。
	if (photo.file_size && photo.file_size > MAX_BYTES) {
		await makeSender(ctx, chatId).sendText(oversizeHint(photo.file_size));
		return;
	}

	// 先标记已见，避免上传中途重投造成重复上传
	await markSeen(deps.stateKv, photo.file_unique_id);

	// `fresh = shouldReceipt`：相册里除第一张之外不再单独发回执，
	// 但依然会正常上传、正常落库（只是没有那条「正在上传…」消息可改写，结果会新发一条）。
	await runUpload(
		ctx,
		chatId,
		{
			file_id: photo.file_id,
			file_unique_id: photo.file_unique_id,
			width: photo.width,
			height: photo.height,
		},
		isDocument,
		shouldReceipt,
		null,
		deps,
	);
}

/**
 * 处理「🔄 重试」按钮 —— `bot.action(/^retry:/)` 的回调。
 *
 * 顺序上有一条硬约束：Telegram 要求 `answerCallbackQuery` 在 **3 秒**内应答
 * （否则客户端一直转圈），而上传要 3~5 秒。所以**先应答、再干活**，绝不能反过来。
 *
 * 门票消费即作废，所以连点两下只有第一次能拿到 ticket：第二次读到 null，
 * 走「已失效」分支 —— 天然防重复上传，不需要额外的锁。
 */
export async function handleRetry(
	ctx: Context,
	token: string,
	deps: PhotoDeps,
): Promise<void> {
	// 先应答，消掉客户端那个转圈。整个流程只应答一次 ——
	// 第二次 answerCallbackQuery 会被 Telegram 拒（query 已被消费）。
	await ctx.answerCbQuery("收到，重试中…");

	const ticket: RetryTicket | null = await consumeTicket(deps.stateKv, token);
	if (!ticket) {
		logger.warn("重试门票无效（已用过或已过期）", { token });
		return;
	}

	const chatId = ctx.chat?.id;
	if (deps.ownerChatId && chatId !== deps.ownerChatId) {
		logger.warn("非白名单 chat 点重试，静默丢弃", { chatId });
		return;
	}

	logger.info("收到重试请求", { chatId, fileId: ticket.fileId });

	// 和首次上传一样先立标记，避免重试期间的重投造成重复上传。
	// ⚠️ 键用的是 fileUniqueId（与 handlePhoto 一致），不是 fileId。
	await markSeen(deps.stateKv, ticket.fileUniqueId);

	// 失败消息挂在 callback_query.message 上。
	// ⚠️ 不能读 `ctx.message` —— 回调型 update 里 Telegraf 不会填它（只有 callbackQuery.message），
	//    读了会永远得到 null，于是重试结果退化成「再发一条新消息」，
	//    用户看到的就不再是「同一条就地更新」了。
	const cbMessage = ctx.callbackQuery?.message;
	const messageId =
		cbMessage && typeof cbMessage === "object" && "message_id" in cbMessage
			? (cbMessage as { message_id: number }).message_id
			: null;

	await runUpload(
		ctx,
		ticket.chatId,
		{
			// Telegram 的 file_id 长期有效，直接拿它重新下载；宽高首次已解析好，
			// 所以 isDocument 传 false 也不会触发文件头解析（宽高齐全）。
			file_id: ticket.fileId,
			file_unique_id: ticket.fileUniqueId,
			width: ticket.width,
			height: ticket.height,
		},
		false,
		// fresh = false：复用那条失败消息，不新发回执
		false,
		messageId,
		deps,
	);
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
