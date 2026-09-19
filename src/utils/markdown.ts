/**
 * 供 Telegram 消息使用的格式化工具。
 *
 * 全部消息统一用 `parse_mode: "Markdown"`（即 Telegram 的 legacy Markdown）。
 * 它支持的语法有限但够用：`*粗体*`、`_斜体_`、`` `等宽` ``、`[文字](链接)`。
 * 注意点：
 *  - 只支持**单个** `*` / `_`，不支持 `**`（那是 MarkdownV2）。写成 `**x**` 会渲染出多余的星号。
 *  - 用户可见文本里的 `*` `_` `` ` `` `[` 必须转义，否则会被当成语法。
 */

/** 字节数转成人读的大小。 */
export function formatBytes(bytes: number | undefined): string {
	if (!bytes || bytes <= 0) return "大小未知";
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
	return `${(kb / 1024).toFixed(2)} MB`;
}

/** 生成一个指向原图的 Markdown 链接，链接文字用较短的「预览」而非长 hash。 */
export function imageLink(url: string, label = "预览"): string {
	return `[${label}](${url})`;
}

/** 转义 legacy Markdown 里有特殊含义的字符。 */
export function escapeMarkdown(text: string): string {
	return text.replace(/([_*`\[])/g, "\\$1");
}

/** 发送选项；解析模式由 sendWithFallback 自己决定。 */
export interface SendOptions {
	/** 关掉链接预览。默认开启，因为 9 条图的预览会刷屏 */
	disablePreview?: boolean;
}

/**
 * 发送一条消息，优先按 Markdown 渲染，失败则退回纯文本。
 *
 * 为什么必须有这个兜底：legacy Markdown 只要有一个没配对的 `*` / `_` / `` ` ``，
 * Telegram 就整条拒收（400 can't parse entities）。而错误信息里恰恰经常出现
 * 这类字符（比如 `CantParseEntities: ...` 或 URL 里的下划线）。
 * 与其让用户什么都收不到，不如退化成纯文本。
 */
export async function sendWithFallback(
	send: (text: string, parseMode?: "Markdown", options?: SendOptions) => Promise<unknown>,
	text: string,
	options: SendOptions = {},
): Promise<void> {
	try {
		await send(text, "Markdown", options);
	} catch {
		// Markdown 解析失败（或任何其他原因）时，退化成纯文本再试一次
		await send(text, undefined, options);
	}
}
