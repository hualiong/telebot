// 诊断工具：从本机（经 HTTP 代理）读写 Telegram API，并把积压的更新转投给已部署的 Worker。
//
//   node scripts/tg-diag.mjs info          # 打印完整 getWebhookInfo
//   node scripts/tg-diag.mjs updates       # 摘掉 webhook、取回积压更新、再装回 webhook
//   node scripts/tg-diag.mjs forward       # 摘掉 webhook、把积压更新转投给 Worker、再装回
//
// Telegram 调用的方式：走本地 HTTP 代理（默认 http://127.0.0.1:7890）的 curl。
// 转投给 Worker 用原生 fetch —— workers.dev 穿透代理可达，且 Worker 自己出网到 Telegram 不受墙影响。

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.env.TG_BOT_TOKEN;
const PROXY = process.env.TG_PROXY ?? "http://127.0.0.1:7890";
/**
 * 两个域名，用途不同，别混：
 *  - `WORKER`  —— 本机**直连**用。`*.workers.dev` 在本机被 DNS 污染（解析到 Facebook IP），
 *                  直连和代理都不通，所以本地调试走自定义域（国内有加速）。
 *  - `WEBHOOK` —— **生产 webhook**，必须留在 workers.dev。自定义域只是本地便利，
 *                  Telegram 侧的投递仍走 workers.dev。
 */
const WORKER = process.env.TG_WORKER ?? "https://telebot.hualiang.fun";
const WEBHOOK = process.env.TG_WEBHOOK ?? "https://telebot.hualiang.workers.dev/webhook";

if (!TOKEN) {
	console.error("需要设置 TG_BOT_TOKEN 环境变量");
	process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

/** 经代理调 Telegram。用 curl 是因为 Node 的 fetch 不认 HTTPS_PROXY。 */
function tg(method, params = {}) {
	const url = new URL(`${API}/${method}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
	const out = execFileSync(
		"curl.exe",
		["-s", "-k", "--max-time", "30", "-x", PROXY, url.toString()],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	return JSON.parse(out);
}

/**
 * POST 给 Worker。**也必须走代理** —— 本机 DNS 对 *.workers.dev 被污染，
 * 直连只会 ConnectTimeout。body 写临时文件免得命令行转义出问题。
 */
function postToWorker(pathname, jsonBody) {
	const dir = mkdtempSync(join(tmpdir(), "tgdiag-"));
	const file = join(dir, "body.json");
	writeFileSync(file, JSON.stringify(jsonBody), "utf8");
	const out = execFileSync(
		"curl.exe",
		[
			"-s", "-k", "--max-time", "120", "-x", PROXY,
			"-w", "\n__HTTP__%{http_code}",
			"-X", "POST",
			"-H", "Content-Type: application/json",
			"--data-binary", `@${file}`,
			`${WORKER}${pathname}`,
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const i = out.lastIndexOf("\n__HTTP__");
	return {
		status: i >= 0 ? out.slice(i + 9).trim() : "?",
		body: i >= 0 ? out.slice(0, i) : out,
	};
}

const cmd = process.argv[2] ?? "info";

if (cmd === "info") {
	const r = tg("getWebhookInfo");
	console.log(JSON.stringify(r, null, 2));
}

if (cmd === "updates" || cmd === "forward") {
	const before = tg("getWebhookInfo").result;
	console.log("最近一次投递错误:", before.last_error_message ?? "(无)");
	console.log("待处理更新数:", before.pending_update_count);

	// 摘掉 webhook 才能 getUpdates
	console.log("\n→ deleteWebhook");
	console.log(JSON.stringify(tg("deleteWebhook").result));

	let updates = [];
	try {
		const r = tg("getUpdates", { timeout: 0, limit: 100 });
		if (!r.ok) {
			console.error("getUpdates 失败:", JSON.stringify(r));
		} else {
			updates = r.result;
		}
	} finally {
		console.log("\n→ setWebhook 装回（生产域名）");
		console.log(
			JSON.stringify(tg("setWebhook", { url: WEBHOOK }).result),
		);
	}

	console.log(`\n取回 ${updates.length} 条积压更新`);
	for (const u of updates) {
		const m = u.message ?? u.edited_message ?? {};
		console.log(
			`  update_id=${u.update_id} chat_id=${m.chat?.id} ` +
				`type=${m.photo ? `photo(${m.photo.length})` : m.document ? "document" : "text/other"} ` +
				`media_group=${m.media_group_id ?? "-"}`,
		);
		if (m.document) {
			console.log(
				`     document: mime=${m.document.mime_type} name=${m.document.file_name} size=${m.document.file_size}`,
			);
		}
	}

	if (cmd === "forward" && updates.length) {
		console.log("\n→ 转投给 Worker（每条一次，避免重复上传）");
		for (const u of updates) {
			const res = postToWorker("/webhook", u);
			console.log(`  update_id=${u.update_id} → HTTP ${res.status} ${res.body.slice(0, 400)}`);
		}
		console.log("\n转投完成。Telegram 那边现在应该能看到回复了。");
	}
}
