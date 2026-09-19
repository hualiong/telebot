import type { Context, Telegraf } from "telegraf";

import { DEFAULT_CONTENT } from "../services/acfun";
import { loadCollection, resetCollection } from "../services/collection";
import { QUOTA } from "../services/poster";
import { sendWithFallback } from "../utils/markdown";
import { describeCollection } from "./photo";
import { logger } from "../utils/logger";

/** 命令处理器需要的依赖。 */
export interface CommandDeps {
	stateKv: KVNamespace;
	ownerChatId?: number;
	/** 触发一次发帖流程；结果由 poster 自己通过 Telegram 回报 */
	flush: (content?: string) => Promise<void>;
}

/**
 * 注册所有 bot 命令与事件处理器。
 *
 * 注意：`on("photo")` 在 Bot 构造函数里注册，必须先于这里的 `on("message")` 兜底处理器，
 * 否则带照片的消息会被兜底逻辑吃掉。
 */
export function registerCommands(bot: Telegraf, deps: CommandDeps): void {
	// 所有面向用户的处理都先过白名单：非本人**完全不回应**，
	// 连 /start /help / 文本兜底都不搭理 —— 外人无法从这个 Bot 拿到任何信息。
	bot.command("start", (ctx) => withOwner(ctx, deps, handleStart));
	bot.command("help", (ctx) => withOwner(ctx, deps, handleHelp));
	bot.command("status", (ctx) => withOwner(ctx, deps, (c) => handleStatus(c, deps)));
	bot.command("post", (ctx) => withOwner(ctx, deps, (c) => handlePost(c, deps)));
	bot.command("clear", (ctx) => withOwner(ctx, deps, (c) => handleClear(c, deps)));

	// 兜底：非命令、非图片的文本
	bot.on("message", (ctx) => withOwner(ctx, deps, handleMessage));

	bot.catch((err, ctx) => {
		logger.error("Bot error", { error: err, update: ctx.update });
	});
}

/**
 * 白名单闸门：是本人就放行，否则**静默丢弃**（不回任何消息）。
 *
 * 全 Bot 只有这一处判断，避免各个 handler 各写一遍、漏掉某个入口。
 */
async function withOwner(
	ctx: Context,
	deps: CommandDeps,
	handler: (ctx: Context) => Promise<void>,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (deps.ownerChatId && chatId !== deps.ownerChatId) {
		logger.warn("非白名单 chat，静默忽略", { chatId, text: ctx.message && "text" in ctx.message ? ctx.message.text : undefined });
		return;
	}
	await handler(ctx);
}

async function handleStart(ctx: Context): Promise<void> {
	await ctx.reply(
		[
			"👋 *我是梗图机器人。*",
			"",
			`把梗图一张张发给我，凑满 *${QUOTA} 张* 我就会自动发一条 AcFun 动态。`,
			"",
			"每发一张图，那条 `📥 收到，正在上传…` 会*就地变成*上传结果，",
			"不会再多刷一条消息。",
			"",
			"用 /help 看全部命令。",
		].join("\n"),
		{ parse_mode: "Markdown" },
	);
}

async function handleHelp(ctx: Context): Promise<void> {
	await ctx.reply(
		[
			"*📖 可用命令*",
			"",
			"`/status` — 查看当前收集进度与每张图的直链",
			"`/post`  — 立即发布（不足 9 张也能强制发）",
			"`/clear` — 清空已收集的图片",
			"`/help`  — 显示这条帮助",
			"",
			"*📥 怎么用*",
			"把梗图发给我就行。每张图只会占 *一条* 消息：",
			"　📥 收到，正在上传…",
			"　⤵️ 上传完成后这条消息就地变成上传结果",
			"",
			`*⚙️ 关于发布*`,
			`凑满 ${QUOTA} 张自动发布，正文：\`${DEFAULT_CONTENT}\``,
			"",
			"*📎 支持的形式*",
			"照片、或以「文件」发送的图都可以。",
			"格式支持 JPEG / PNG / WebP，单张 ≤ 1 MiB。",
		].join("\n"),
		{ parse_mode: "Markdown" },
	);
}

async function handleStatus(ctx: Context, deps: CommandDeps): Promise<void> {
	const { text } = await describeCollection(deps.stateKv);
	// Markdown 是为了让「预览」变成可点开的直链；关掉预览免得 9 张图刷屏
	await sendWithFallback(
		(t, parseMode, options) => {
			const extra: any = {};
			if (parseMode) extra.parse_mode = parseMode;
			if (options?.disablePreview) extra.link_preview_options = { is_disabled: true };
			return ctx.reply(t, extra);
		},
		text,
		{ disablePreview: true },
	);
}

async function handlePost(ctx: Context, deps: CommandDeps): Promise<void> {
	const c = await loadCollection(deps.stateKv);
	if (c.images.length === 0) {
		await ctx.reply("📭 还没有收集到图片，先发几张梗图吧。");
		return;
	}

	await ctx.reply(
		c.images.length >= QUOTA
			? `🚀 开始发布 ${QUOTA} 张…`
			: `🚀 不足 ${QUOTA} 张（当前 ${c.images.length} 张），按强制发布处理…`,
	);
	await deps.flush();
}

async function handleClear(ctx: Context, deps: CommandDeps): Promise<void> {
	const c = await loadCollection(deps.stateKv);
	if (c.images.length === 0) {
		await ctx.reply("📭 本来就是空的。");
		return;
	}
	await resetCollection(deps.stateKv);
	await ctx.reply(`🗑 已清空 ${c.images.length} 张收集（AcFun 上已上传的图不会被删除）。`);
}

async function handleMessage(ctx: Context): Promise<void> {
	await ctx.reply("我只认梗图照片 🙂 直接发图片给我，或用 /help 看命令。");
}
