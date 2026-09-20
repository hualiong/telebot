/**
 * 供 Telegram 消息使用的格式化工具。
 *
 * 默认用 `parse_mode: "Markdown"`（即 Telegram 的 legacy Markdown）。
 * 它支持的语法有限但够用：`*粗体*`、`_斜体_`、`` `等宽` ``、`[文字](链接)`。
 * 注意点：
 *  - 只支持**单个** `*` / `_`，不支持 `**`（那是 MarkdownV2）。写成 `**x**` 会渲染出多余的星号。
 *  - 用户可见文本里的 `*` `_` `` ` `` `[` 必须转义，否则会被当成语法。
 *
 * ⚠️ legacy Markdown **没有引用块**。要引用只能用 `parse_mode: "HTML"`，
 * 所以本文件另有一组 `html*` 工具（见 `htmlBlockquote`）。
 * 一个 parse_mode 只作用于它自己那条消息，所以两种混用互不影响。
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

/**
 * 转义 HTML 里有特殊含义的字符，供 `parse_mode: "HTML"` 使用。
 *
 * `&` 必须**先**换，否则后面替换出来的 `&lt;` / `&gt;` 会被二次转义成 `&amp;lt;`。
 * `"` 一并处理，这样返回值塞进任何属性（如 `<a href="...">`）也安全。
 */
export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 把一段纯文本包成 Telegram 的引用块（blockquote）。
 *
 * 两个坑：
 *  - HTML 模式下**字面换行会被吃掉**，必须换成 `<br>`，否则多行文本会挤成一行；
 *  - `expandable` 让长内容默认折叠，正文只露一行，点一下才展开。报错详情正适合这样收起来。
 *
 * 转义由本函数负责，调用方只管传原始文本。
 */
export function htmlBlockquote(text: string, expandable = false): string {
	const inner = escapeHtml(text).replace(/\r?\n/g, "<br>");
	return `<blockquote${expandable ? " expandable" : ""}>${inner}</blockquote>`;
}

/** 发送选项；parse_mode 由 sendWithFallback 自己按 mode 决定，调用方不要手写。 */
export interface SendOptions {
	/** 解析模式。默认 Markdown；需要引用块时传 "HTML" */
	mode?: "Markdown" | "HTML";
	/** 是否允许链接预览。默认关闭，因为 9 条图的预览会刷屏 */
	link?: boolean;
}

/**
 * 发送一条消息，优先按指定模式渲染，失败则退回纯文本。
 *
 * 为什么必须有这个兜底：legacy Markdown 只要有一个没配对的 `*` / `_` / `` ` ``，
 * Telegram 就整条拒收（400 can't parse entities）；HTML 模式则会在标签不合法时整条拒收。
 * 而错误信息里恰恰经常出现这类字符（比如 `CantParseEntities: ...`、URL 里的下划线、
 * 或服务端文案里夹带的尖括号）。与其让用户什么都收不到，不如退化成纯文本。
 *
 * 回调只需把 options 原样交给 Telegraf（`ctx.reply(text, options)`）；
 * 解析模式与链接预览都在这里统一填好。
 */
export async function sendWithFallback(
	send: (text: string, options: Record<string, unknown>) => Promise<unknown>,
	text: string,
	options: SendOptions = {},
): Promise<void> {
	const link = options.link ?? false;
	const extra = (withMode?: "Markdown" | "HTML"): Record<string, unknown> => ({
		...(withMode ? { parse_mode: withMode } : {}),
		link_preview_options: { is_disabled: !link },
	});

	try {
		await send(text, extra(options.mode ?? "Markdown"));
	} catch {
		// 解析失败（或任何其他原因）时，退化成纯文本再试一次
		await send(text, extra());
	}
}
