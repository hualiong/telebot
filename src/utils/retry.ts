/**
 * 上传失败后的「重试门票」。
 *
 * 为什么需要它：Telegram 内联按钮的 `callback_data` **硬上限 64 字节**
 * （官方对 InlineKeyboardButton.callback_data 的定义就是 1~64 bytes），
 * 而 Telegram 的 `file_id` 通常 60~90 字符 —— 直接塞进按钮会超限。
 *
 * 所以按钮里只放一个短 token，真正的参数存在 KV 里：
 *
 *   callback_data = "retry:<16 位 hex>"（约 22 字节，安全）
 *   KV["retry:<token>"] = RetryTicket
 *
 * token 是 64 位随机数，撞键概率可忽略；消费即删除（`consumeTicket` 会 delete），
 * 所以同一张门票只能用一次 —— 这天然挡住了「连点两下按钮重复上传」。
 * 同时给 24h TTL 兜底：用户永远不点，键也会自己消失。
 */

/** KV 里 key 的前缀，和 `seen:` / `acfun:` 并列，避免污染同名空间里的其它键。 */
const RETRY_PREFIX = "retry:";

/** 门票有效期。和 `seen:` 标记一致；失效后用户重发图片即可。 */
const RETRY_TTL_SECONDS = 86400;

/**
 * 重试一张图所需的全部信息。
 *
 * 刻意**只存标识符，不存图片字节** —— 重试时重新从 Telegram 下载（一次子请求），
 * 这样门票小到可以随意放 KV，也不受 KV 值 25 MiB 上限的牵扯。
 */
export interface RetryTicket {
	/** Telegram file_id，重试时用它重新下载，也用作上传文件名 */
	fileId: string;
	/**
	 * Telegram file_unique_id —— **幂等去重用的键**。
	 *
	 * 必须随门票一起带上：`seen:` 标记的键是它（跨消息稳定），不是 file_id。
	 * 重试时若拿 file_id 去标记，标记会写到一个永远没人查的键上，
	 * 去重随即失效 —— 这类错配是静默的，只在重复上传时才暴露。
	 */
	fileUniqueId: string;
	/** 重试后的上传用哪个扩展名（首次上传时已探明格式） */
	ext: string;
	/** 图宽高。AcFun 的 imgs[] 需要，首次上传时已解析好，重试不必再解析文件头 */
	width: number;
	height: number;
	/** 失败消息就在这个 chat 里 */
	chatId: number;
}

/** 随机 16 位十六进制（64 位熵）。 */
function randomToken(): string {
	const b = new Uint8Array(8);
	crypto.getRandomValues(b);
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

/** 存一张门票，返回要塞进按钮 callback_data 的短 token。 */
export async function saveTicket(kv: KVNamespace, ticket: RetryTicket): Promise<string> {
	const token = randomToken();
	await kv.put(`${RETRY_PREFIX}${token}`, JSON.stringify(ticket), {
		expirationTtl: RETRY_TTL_SECONDS,
	});
	return token;
}

/**
 * 取出并**作废**一张门票。token 不存在（已用过 / 已过期 / 伪造）时返回 null。
 *
 * 先删后读：删除是原子的，所以两个并发回调里最多只有一个能拿到值，
 * 另一个必然读到 null —— 这正是我们要的「一次一张票」。
 */
export async function consumeTicket(kv: KVNamespace, token: string): Promise<RetryTicket | null> {
	// 只接受我们自己生成的形状，挡掉畸形 token 拼进 KV key
	if (!/^[0-9a-f]{16}$/.test(token)) return null;

	const key = `${RETRY_PREFIX}${token}`;
	const raw = await kv.get(key);
	await kv.delete(key);
	if (!raw) return null;

	try {
		const t = JSON.parse(raw) as RetryTicket;
		if (
			typeof t?.fileId !== "string" ||
			typeof t?.fileUniqueId !== "string" ||
			typeof t?.chatId !== "number"
		) {
			return null;
		}
		return t;
	} catch {
		return null;
	}
}

/** 拼一个按钮用的 callback_data。 */
export const retryCallbackData = (token: string): string => `retry:${token}`;

/** `bot.action()` 用的匹配式，顺带把 token 抓出来。 */
export const RETRY_CALLBACK_PATTERN = /^retry:([0-9a-f]{16})$/;
