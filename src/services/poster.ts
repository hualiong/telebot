import { buildCookie, DEFAULT_CONTENT, postMoment, RESULT_RATE_LIMITED } from "./acfun";
import {
	addImage,
	getAcfunToken,
	isPostingCoolingDown,
	loadCollection,
	resetCollection,
	restoreAfterFailure,
} from "./collection";
import { logger } from "../utils/logger";
import { escapeMarkdown } from "../utils/markdown";
import type { AcfunImage, Collection } from "../types/acfun";

/**
 * 收集配额：凑够这么多张就发一条动态（AcFun 单条动态最多 9 张图）。
 */
export const QUOTA = 9;

/** poster 的依赖。只依赖最小接口，方便复用与测试。 */
export interface PosterDeps {
	/** 状态 KV；同时也是 acPasstoken 的来源（同一个 cloud-mail namespace） */
	stateKv: KVNamespace;
	/** 覆盖凭证（本地调试用） */
	cookieOverride?: string;
	/** 发提示消息给某个 chat */
	notify: (chatId: number, text: string) => Promise<void>;
}

/** 上传完成后落库，返回追加后的收集状态。 */
export async function collectImage(
	stateKv: KVNamespace,
	chatId: number,
	image: AcfunImage,
): Promise<Collection> {
	return addImage(stateKv, image, { chatId });
}

/**
 * 凑够 9 张就发动态。返回实际发出的条数（0 或 1）。
 *
 * 设计要点：**只在成功后才清空收集**。撞到 140011 限流时 9 条直链会原样留在 KV 里，
 * 之后发 `/post` 就能重发，不会丢图。
 */
export async function flushIfReady(
	deps: PosterDeps,
	options: { force?: boolean; content?: string } = {},
): Promise<{ posted: number; reason?: string }> {
	const c = await loadCollection(deps.stateKv);
	const chatId = c.chatId;

	if (c.images.length === 0) {
		if (chatId) await deps.notify(chatId, "还没有收集到任何图片。");
		return { posted: 0, reason: "empty" };
	}
	if (c.images.length < QUOTA && !options.force) {
		return { posted: 0, reason: "not-enough" };
	}
	if (!chatId) {
		logger.error("收集状态缺少 chatId，无法回报结果");
		return { posted: 0, reason: "no-chat-id" };
	}
	// 并发闸：挡掉 Telegram 重投导致的重复发帖。只读判定，避免和后面的写撞进 KV 的 1 写/秒窗口
	if (await isPostingCoolingDown(deps.stateKv)) {
		return { posted: 0, reason: "cooldown" };
	}

	const images = c.images.slice(0, QUOTA);
	const leftover = c.images.length - images.length;

	try {
		const cookie = buildCookie(await getAcfunToken(deps.stateKv, deps.cookieOverride));

		logger.info("开始发动态", { count: images.length });

		// 先乐观清空（单次写），成功后什么都不用做；
		// 万一失败再写一次把图放回去。这样 `acfun:collection` 每次发帖最多写两次，
		// 且两次之间隔着一次网络往返，不会撞上 KV 的「同一 key 1 写/秒」。
		await resetCollection(deps.stateKv);

		const res = await postMoment(
			cookie,
			images.map((im) => ({ url: im.url, width: im.width, height: im.height })),
			options.content ?? DEFAULT_CONTENT,
		);

		const lines = [
			`🎉 *新动态已发布* · [查看](${res.shareUrl})`,
		];
		if (leftover > 0) lines.push(`📎 还剩 ${leftover} 张，继续攒。`);
		await deps.notify(chatId, lines.join("\n"));
		return { posted: 1 };
	} catch (error: any) {
		const rateLimited = error?.result === RESULT_RATE_LIMITED;
		logger.error("发动态失败", { message: error?.message, rateLimited });

		// 把 9 张图原样放回去，并记下时间戳作为退避依据
		await restoreAfterFailure(deps.stateKv, images, chatId);

		const detail = escapeMarkdown(
			String(error?.message ?? error).replace(/^发动态失败[:：]\s*/, ""),
		);
		const hint = rateLimited
			? `⏳ *AcFun 限流中*（约 1 条 / 数分钟）\n${images.length} 张图已保留，过几分钟发 /post 即可重发。`
			: `❌ *发动态失败*\n${detail}\n${images.length} 张图已保留，可发 /post 重试。`;
		await deps.notify(chatId, hint);
		return { posted: 0, reason: "failed" };
	}
}
