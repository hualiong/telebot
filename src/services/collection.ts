import type { AcfunImage, Collection } from "../types/acfun";
import { logger } from "../utils/logger";

/**
 * 收集状态与幂等去重，都放在 KV 里。
 *
 * 只有一个 namespace 绑定（`STATE_KV`），它指向用户已有的 **`cloud-mail`** namespace：
 *  - `acfun:collection`  / `seen:*` —— 本 Bot 的状态
 *  - `token`                       —— acPasstoken，由 `acfun-sign-in` Worker 定期轮换
 *
 * 复用同一个 namespace 是有意为之：token 就在里面，读取时天然拿到最新值，
 * 既不用为轮换重新部署，也不用多维护一个绑定。
 *
 * key 约定：
 *  - `acfun:collection`      → Collection（直链列表 + 发帖闸时间戳）
 *  - `seen:<file_unique_id>` → "1"，24h TTL，用幂等去重挡住 Telegram 的重投
 */

/** 已上传直链的收集状态。 */
const COLLECTION_KEY = "acfun:collection";

/**
 * 去重标记保留 24 小时。
 * KV 对同一个 key 限 **1 写/秒**，所以整个发帖流程对 `acfun:collection` 只写一次：
 * 先清空 → 成功就结束；失败再写一次把图放回去（中间隔着一次网络往返，不会撞进同一秒）。
 */
const SEEN_TTL_SECONDS = 86400;

/**
 * 同一批内的发帖冷却。正常路径下 collection 会被清空，这个闸只是兜底：
 * 万一 Telegram 重投了「第 9 张」那条更新，避免瞬间发出两条动态。
 */
const POST_COOLDOWN_MS = 120_000;

export async function loadCollection(kv: KVNamespace): Promise<Collection> {
	const raw = await kv.get(COLLECTION_KEY, "json");
	if (!raw || typeof raw !== "object") return { images: [] };
	const c = raw as Collection;
	// ⚠️ 必须把每个字段都显式带出来。早期版本漏了 chatId，
	// 导致 flushIfReady 永远拿不到收件人、发帖结果发不出去，而且是静默失败。
	return {
		images: Array.isArray(c.images) ? c.images : [],
		chatId: typeof c.chatId === "number" ? c.chatId : undefined,
		postingAt: typeof c.postingAt === "number" ? c.postingAt : undefined,
	};
}

export async function saveCollection(kv: KVNamespace, c: Collection): Promise<void> {
	await kv.put(COLLECTION_KEY, JSON.stringify(c));
}

export async function resetCollection(kv: KVNamespace): Promise<void> {
	await kv.delete(COLLECTION_KEY);
}

/** 追加一张已上传成功的图，返回追加后的状态。 */
export async function addImage(
	kv: KVNamespace,
	image: AcfunImage,
	options: { chatId?: number } = {},
): Promise<Collection> {
	const c = await loadCollection(kv);
	c.images.push(image);
	if (options.chatId !== undefined) c.chatId = options.chatId;
	// 单次 put：KV 对同一个 key 限 1 写/秒，能合并的写就合并
	await saveCollection(kv, c);
	return c;
}

/**
 * 发帖冷却判定（只读不写）。
 * 注意：KV 对同一个 key 限 **1 写/秒**，所以冷却闸用「读时判定 + 失败时补写」，
 * 而不是「先写 claim 再干活」——否则会和稍后的删除/写入撞在 1 秒窗口里。
 */
export async function isPostingCoolingDown(kv: KVNamespace): Promise<boolean> {
	const c = await loadCollection(kv);
	const cooling =
		!!c.postingAt && Date.now() - c.postingAt < POST_COOLDOWN_MS;
	if (cooling) logger.warn("发帖冷却中，跳过", { postingAt: c.postingAt });
	return cooling;
}

/** 发帖失败时回滚：把图放回去，并记录时间戳作为退避依据。**单次写**。 */
export async function restoreAfterFailure(
	kv: KVNamespace,
	images: AcfunImage[],
	chatId?: number,
): Promise<void> {
	const c: Collection = { images, chatId, postingAt: Date.now() };
	await saveCollection(kv, c);
}

/**
 * 幂等去重。Telegram 在 webhook 超时/出错时会重投同一条更新，
 * 用 `file_unique_id`（跨消息稳定）挡住重复上传。
 */
export async function markSeen(kv: KVNamespace, fileUniqueId: string): Promise<void> {
	await kv.put(`seen:${fileUniqueId}`, "1", { expirationTtl: SEEN_TTL_SECONDS });
}

export async function hasSeen(kv: KVNamespace, fileUniqueId: string): Promise<boolean> {
	return (await kv.get(`seen:${fileUniqueId}`)) !== null;
}

/**
 * 读取 acPasstoken。
 *
 * 就放在同一个 KV 里（key = `token`），它由另一个 Worker（`acfun-sign-in`）定期轮换，
 * 所以这里永远是新鲜的，不需要把凭证塞进 secret，也不需要轮换时重新部署。
 * `ACFUN_COOKIE` 环境变量存在时优先，用于本地调试或临时覆盖。
 */
export async function getAcfunToken(kv: KVNamespace, override?: string): Promise<string> {
	if (override) return override;
	const token = await kv.get("token");
	if (!token) {
		throw new Error("KV 里没有 token 键，无法取得 acPasstoken");
	}
	return token.trim();
}
