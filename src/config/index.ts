export interface Config {
	botToken: string;
	/** 白名单 chat id；未设置则不限制 */
	ownerChatId?: number;
	/** acPasstoken 覆盖值；未设置则从 KV 的 `token` 键读取 */
	cookieOverride?: string;
	/**
	 * Telegram API 根地址。**只有离线测试用它** —— 把请求导向一个假域名，
	 * 免得测试意外打到真的 api.telegram.org。生产环境永远不要设置。
	 */
	apiRoot?: string;
}

export const getConfig = (env: any): Config => {
	const raw = env.OWNER_CHAT_ID;
	const ownerChatId =
		raw === undefined || raw === null || String(raw).trim() === ""
			? undefined
			: Number(String(raw).trim());

	return {
		botToken: env.BOT_TOKEN,
		ownerChatId: Number.isFinite(ownerChatId) ? ownerChatId : undefined,
		cookieOverride: env.ACFUN_COOKIE || undefined,
		apiRoot: env.TELEGRAM_API_ROOT || undefined,
	};
};
