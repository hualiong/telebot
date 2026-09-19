import type { ExecutionContext } from "@cloudflare/workers-types";

import { Bot } from "./src/bot";
import { getConfig } from "./src/config";
import { logger } from "./src/utils/logger";

export interface Env {
	/** Telegram Bot Token（secret） */
	BOT_TOKEN: string;
	/**
	 * KV —— 指向用户已有的 **cloud-mail** namespace。
	 * 一个 namespace 装两样东西：本 Bot 的状态（`acfun:collection` / `seen:*`）
	 * 和 `acfun-sign-in` Worker 轮换写入的 `token`（acPasstoken）。
	 */
	STATE_KV: KVNamespace;
	/** 白名单 Telegram user id（明文变量，可选；不设则不限制） */
	OWNER_CHAT_ID?: string;
	/** acPasstoken 覆盖值（secret，可选；本地调试用，设置后优先于 KV 里的 token） */
	ACFUN_COOKIE?: string;
}

/** 从 env 组装一份 Bot。Workers 是无状态的，每次请求都新建一个。 */
function createBot(env: Env): Bot {
	return new Bot(getConfig(env), {
		stateKv: env.STATE_KV,
		cookieOverride: env.ACFUN_COOKIE,
		ownerChatId: getConfig(env).ownerChatId,
	});
}

/**
 * 体检：确认 kv 绑定与 acPasstoken 可用。
 *
 * ⚠️ 这里**故意不调 Telegram** —— 那个检查在 `checkTelegram()` 里，只在 `GET /` 上跑。
 * 原因：`/health` 是廉价的存活探针（可被频繁轮询），而 bot 的对话一旦建立，
 * 机器人就没法再主动给陌生人发消息，`getMe` 的结果也就无法代表「对话可用」。
 */
async function checkBindings(env: Env): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {
		stateKv: !!env.STATE_KV,
		ownerChatId: env.OWNER_CHAT_ID ?? "(未设置，不限制)",
		cookieOverride: env.ACFUN_COOKIE ? "已设置(优先)" : "未设置",
	};

	try {
		// 同一个 namespace 里的 `token` 键就是 acPasstoken。
		// 值较长，这里只报告长度，不落日志。
		const token = env.STATE_KV ? await env.STATE_KV.get("token") : null;
		out.acPasstoken = token ? `已取到(${token.trim().length} 字节)` : "❌ 读取失败";
	} catch (error: any) {
		out.acPasstoken = `❌ ${error?.message ?? error}`;
	}

	try {
		out.stateKvReadable = (await env.STATE_KV.get("acfun:collection")) !== undefined;
	} catch (error: any) {
		out.stateKvReadable = `❌ ${error?.message ?? error}`;
	}

	return out;
}

/**
 * 真正打一次 Telegram，确认 BOT_TOKEN 可用。
 *
 * 加这个是因为踩过一次坑：secret 被写成了 `-NoNewline<token>`（前十个字符是那个
 * 开关的名字），每次调用都 404 → webhook 返回 500 → Telegram 判定投递失败并无限重试，
 * 而当时的 `/health` 只读 KV，照样报 OK，完全没暴露问题。
 *
 * 带超时：出网到 Telegram 偶尔会卡住，这个端点绝不能因此一直挂着不返回。
 */
async function checkTelegram(env: Env): Promise<Record<string, unknown>> {
	const TIMEOUT_MS = 10_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const me = await Promise.race([
			createBot(env).telegram.getMe(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Telegram 无响应（>${TIMEOUT_MS / 1000}s）`)), TIMEOUT_MS);
			}),
		]);
		return { telegram: `✅ @${me.username}` };
	} catch (error: any) {
		const msg = String(error?.message ?? error);
		// 把 token 相关的错误指出来，但不要泄露 token 本身
		const hint = /404|401|Unauthorized/i.test(msg) ? "（BOT_TOKEN 可能不正确或已轮换）" : "";
		return { telegram: `❌ ${msg}${hint}` };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// POST /webhook — 处理 Telegram 更新
			if (path === "/webhook" && request.method === "POST") {
				const update = await request.json();
				await createBot(env).handleWebhook(update);
				return new Response("OK", { status: 200 });
			}

			// GET /webhook?setup=1 — 手动注册 webhook（缺 secret_token 校验，故需显式带上 ?setup=1）
			if (path === "/webhook" && request.method === "GET") {
				if (url.searchParams.get("setup") !== "1") {
					return new Response(
						"此端点用于注册 webhook。请带 ?setup=1 显式调用。",
						{ status: 400 },
					);
				}
				await createBot(env).setupWebhook(url.origin);
				return Response.json({ ok: true, webhook: `${url.origin}/webhook` });
			}

			// GET /health — 廉价存活探针（只查绑定与凭证）
			if (path === "/health") {
				const health = await checkBindings(env);
				const ok = health.acPasstoken !== "❌ 读取失败" && !String(health.acPasstoken).startsWith("❌");
				return Response.json({ ok, ...health }, { status: ok ? 200 : 503 });
			}

			// GET / — 状态页（含一次真实的 Telegram 连通性检查）；带 ?setup=1 时顺带注册 webhook
			if (path === "/" && request.method === "GET") {
				if (url.searchParams.get("setup") === "1") {
					await createBot(env).setupWebhook(url.origin);
				}
				const [bindings, tg] = await Promise.all([checkBindings(env), checkTelegram(env)]);
				return Response.json({
					service: "telebot · Telegram → AcFun 梗图机器人",
					hint: "GET /health 裸探针 · GET /?setup=1 注册 webhook",
					...bindings,
					...tg,
				});
			}

			return new Response("Not found", { status: 404 });
		} catch (error: any) {
			logger.error("Worker error", { message: error?.message, path });
			return new Response(`Internal Server Error: ${error?.message ?? error}`, {
				status: 500,
			});
		}
	},
};
