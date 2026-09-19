// 交互流程验证：驱动**真实的 Bot 类**（真 Telegraf、真 handler），
// 但把 Telegram API 与 AcFun 都换成假的，所以没有任何真实副作用。
//
// 运行：
//   npx esbuild scripts/flow-check.mjs --bundle --platform=node --format=cjs \
//     --outfile=scripts/.flow-check.bundle.cjs && node scripts/.flow-check.bundle.cjs
//
// 两个必须注意的点：
//  1. **必须打包**：源码里的 import 没有扩展名，Node 直接跑解析不了。
//  2. **必须输出 CJS**：Telegraf 是 CommonJS，bundler 输出 ESM 时它的
//     `require("crypto")` 会被换成不支持的 dynamic require 而直接报错。
//     因此主体包在 async IIFE 里（顶层 await 在 CJS 下不合法）。
//
// 为什么起一个本地假 Telegram 服务器、而不是 patch globalThis.fetch：
// Telegraf 用的是它自己打包的 node-fetch（lib/core/network/client.js 里
// `(0, node_fetch_1.default)(apiUrl, config)`），既不读 globalThis.fetch，
// 覆盖实例的 callApi 也拦不住 handler 里的 ctx.telegram。
// 把 apiRoot 指到本地 HTTP 服务是唯一干净的做法：真发真收，但完全不出网。

import { createServer as createHttpServer } from "node:http";

import { Bot } from "../src/bot";

const OWNER = 1971332015;

// Telegraf 是 CJS，bundler 输出 ESM 时它的 require('crypto') 会炸；
// 所以输出 CJS，并把带顶层 await 的主体包进 async IIFE。
async function main() {
const BOT_TOKEN = "111:FAKE";

/** 假 KV：只用到 get/put/delete。 */
function makeKv() {
	const m = new Map();
	return {
		async get(key, type) {
			const v = m.get(key);
			if (v === undefined) return null;
			return type === "json" ? JSON.parse(v) : v;
		},
		async put(key, value) {
			m.set(key, value);
		},
		async delete(key) {
			m.delete(key);
		},
	};
}

/**
 * 假 Telegram API 服务器。Telegraf 与图片下载都指向它 —— 全程不出网。
 * 把收到的调用记到 `calls` 里，供断言使用。
 */
function startFakeTelegram(calls, fileBytes) {
	const server = createHttpServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const chunks = [];

		const finish = () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const send = (obj) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(obj));
			};

			// 图片下载：走我们自己的 fetch，返回构造好的字节
			if (url.pathname.startsWith("/file/")) {
				res.writeHead(200, { "Content-Type": "image/jpeg" });
				res.end(Buffer.from(fileBytes));
				return;
			}

			const method = url.pathname.split("/").pop();
			let payload = {};
			try {
				payload = raw ? JSON.parse(raw) : {};
			} catch { /* 忽略 */ }
			calls.push({ method, payload });

			if (method === "getMe") {
				return send({ ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "t_bot" } });
			}
			if (method === "getFile") {
				return send({ ok: true, result: { file_id: payload.file_id, file_unique_id: "u", file_path: "photos/x.jpg" } });
			}
			if (method === "sendMessage") {
				const id = 100 + calls.filter((c) => c.method === "sendMessage").length;
				const entry = calls[calls.length - 1];
				if (entry) entry.resultId = id;
				return send({ ok: true, result: { message_id: id, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } });
			}
			if (method === "editMessageText") {
				return send({ ok: true, result: { message_id: Number(payload.message_id), date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text } });
			}
			return send({ ok: true, result: {} });
		};

		req.on("data", (c) => chunks.push(c));
		req.on("end", finish);
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, apiRoot: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

/** 最小但合法的 JPEG 字节（够 jpegSize 解析出宽高）。 */
function fakeJpeg(width, height) {
	const b = new Uint8Array(64);
	b.set([0xff, 0xd8], 0);
	b.set([0xff, 0xe0, 0x00, 0x10], 2);
	b.set([0x4a, 0x46, 0x49, 0x46, 0x00], 6);
	b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 22);
	b[27] = (height >> 8) & 0xff;
	b[28] = height & 0xff;
	b[29] = (width >> 8) & 0xff;
	b[30] = width & 0xff;
	return b;
}

const PNG_1080x2340 = (() => {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	b.set([0x00, 0x00, 0x00, 0x0d], 8);
	b.set([0x49, 0x48, 0x44, 0x52], 12);
	const be = (v, p) => { b[p] = (v >>> 24) & 0xff; b[p + 1] = (v >>> 16) & 0xff; b[p + 2] = (v >>> 8) & 0xff; b[p + 3] = v & 0xff; };
	be(1080, 16);
	be(2340, 20);
	return b;
})();

let pass = true;
const check = (label, cond, extra = "") => {
	console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
	if (!cond) pass = false;
};

/**
 * 把一条 update 喂给真实 Bot，返回它实际调用的 Telegram 接口。
 *
 * 两个拦截点：
 *  1. `telegram.callApi`（实例级）—— 覆盖所有 Telegram REST 调用
 *  2. `globalThis.fetch` —— 覆盖图片下载与 AcFun 调用
 */
async function run(label, message, opts = {}) {
	const calls = [];
	const stateKv = opts.stateKv ?? makeKv();
	// 只有一个 KV：状态与 acPasstoken 都在里面
	await stateKv.put("token", "FAKE-TOKEN-FOR-TEST");
	if (opts.seedCollection) {
		await stateKv.put("acfun:collection", JSON.stringify(opts.seedCollection));
	}

	// 起本地假 Telegram，把 apiRoot 指过去 —— 全程不出网
	const fake = await startFakeTelegram(calls, opts.fileBytes ?? fakeJpeg(1280, 1199));

	const bot = new Bot(
		{ botToken: BOT_TOKEN, ownerChatId: OWNER, apiRoot: fake.apiRoot },
		{ stateKv, ownerChatId: OWNER },
	);

	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(typeof input === "string" ? input : input?.url ?? input);

		// 假 AcFun（图片下载由本地假 Telegram 直接返回，不走这里）
		if (url.includes("acfun") || url.includes("kuaishouzt")) {
			const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
			if (url.includes("getToken")) return json({ result: 0, info: { token: "T" } });
			if (url.includes("getUrlAfterUpload")) {
				return json({ result: 0, url: `https://imgs.aixifan.com/newUpload/1_abc.${opts.expectExt ?? "jpg"}` });
			}
			if (url.includes("resume")) return json({ result: 1, existed: false, fragment_index: -1 });
			if (url.includes("moment/add")) {
				return json({ result: 0, moment: { momentId: 999, shareUrl: "https://m.acfun.cn/communityCircle/moment/999" } });
			}
			return json({ result: 1 });
		}

		// 任何其他出网都是测试没桩干净，直接报错而不是偷偷打真网络
		if (url.startsWith(fake.apiRoot)) return realFetch(input, init);
		throw new Error(`flow-check: 未预期的出网请求 ${url}`);
	};

	try {
		await bot.handleWebhook({ update_id: Math.floor(Math.random() * 1e6), message });
	} finally {
		globalThis.fetch = realFetch;
		await fake.close();
	}

	/**
	 * 按时间顺序重建聊天。
	 * Telegraf 每次 handleUpdate 都会自己调一次 getMe（缓存 botInfo），
	 * 那是它内部行为，不算「Bot 回了消息」，所以断言时用 business 过滤掉。
	 */
	const chat = [];
	for (const c of calls) {
		if (c.method === "sendMessage") chat.push({ id: c.resultId, text: c.payload?.text ?? "" });
		if (c.method === "editMessageText") {
			const target = chat.find((m) => m.id === Number(c.payload?.message_id));
			if (target) target.text = c.payload.text ?? "";
		}
	}
	const sends = calls.filter((c) => c.method === "sendMessage").map((c) => c.payload?.text ?? "");
	const edits = calls.filter((c) => c.method === "editMessageText").map((c) => c.payload?.text ?? "");
	const visible = chat.map((m) => m.text);
	// 排除 Telegraf 自己的 getMe，只看「业务上真的发了什么」
	const business = calls.filter((c) => c.method !== "getMe");

	console.log(`\n### ${label}`);
	for (const c of calls) {
		const t = c.payload?.text ?? c.payload?.file_id ?? "";
		console.log(`   → ${c.method}${t ? `: ${String(t).replace(/\n/g, " / ")}` : ""}`);
	}
	if (!calls.length) console.log("   （零调用）");
	console.log(`   state=${JSON.stringify(await stateKv.get("acfun:collection"))}`);
	return { calls, business, sends, edits, visible, stateKv };
}

const baseMsg = (extra, chatId = OWNER) => ({
	message_id: 1,
	date: 0,
	chat: { id: chatId, type: "private" },
	from: { id: chatId, is_bot: false, first_name: "p" },
	...extra,
});

const cmd = (text) => ({ text, entities: [{ type: "bot_command", offset: 0, length: text.length }] });

// ---- 1. 陌生人：图片、文本、命令，全部零响应 ----
{
	const cases = [
		["陌生人发图", { photo: [{ file_id: "f", file_unique_id: "s1", width: 100, height: 100, file_size: 1000 }] }],
		["陌生人纯文本", { text: "hello" }],
		["陌生人 /start", cmd("/start")],
		["陌生人 /status", cmd("/status")],
		["陌生人 /help", cmd("/help")],
		["陌生人 /post", cmd("/post")],
		["陌生人 /clear", cmd("/clear")],
	];
	for (const [label, extra] of cases) {
		const { business } = await run(label, baseMsg(extra, 999000001));
		check(`${label} → 零响应`, business.length === 0, `实际 ${business.length} 次业务调用`);
	}
}

// ---- 2. 本人发图：只占一条消息（收到 → 就地改写为结果）----
{
	const { calls, sends, edits, visible } = await run("本人发图", baseMsg({ photo: [{ file_id: "f", file_unique_id: "p1", width: 1280, height: 1199, file_size: 70000 }] }));
	check("只发送了一次 sendMessage", sends.length === 1, `实际 ${sends.length}`);
	check("发的是「收到，正在上传…」", sends[0] === "📥 收到，正在上传…", JSON.stringify(sends[0]));
	check("用 editMessageText 而非新消息呈现结果", edits.length === 1, `编辑 ${edits.length} 次`);
	const t = edits[0] ?? "";
	check("「上传成功」是超链接而非回显直链", /^✅ \[上传成功\]\(https:\/\//.test(t), JSON.stringify(t));
	check("含大小与 (n / 9)", /·\s*[\d.]+ (B|KB|MB)（1 \/ 9）/.test(t), JSON.stringify(t));
	check("不显示分辨率", !/\d+×\d+/.test(t), JSON.stringify(t));
	check("聊天里只留下一条消息", visible.length === 1, `实际 ${visible.length} 条`);
	check("留下的是结果而非回执", (visible[0] ?? "").includes("上传成功"), JSON.stringify(visible[0]));
	check("Markdown 用单星号（legacy 语法）", !/\*\*/.test(t));
}

// ---- 3. 超大图：只回一条提示，不回「正在上传」----
{
	const { sends, edits } = await run("超大图(2MB)", baseMsg({ photo: [{ file_id: "f", file_unique_id: "big1", width: 100, height: 100, file_size: 2 * 1024 * 1024 }] }));
	check("只回一条超限提示", sends.length === 1 && sends[0].includes("超过 1 MiB"), `实际 ${sends.length} 条`);
	check("没有误报「正在上传」", !sends.some((s) => s.includes("正在上传")));
	check("没有多余编辑", edits.length === 0);
}

// ---- 4. document + PNG ----
{
	const { edits } = await run("document PNG", baseMsg({ document: { file_id: "f", file_unique_id: "png1", file_name: "a.png", mime_type: "image/png", file_size: 30000 } }), { fileBytes: PNG_1080x2340, expectExt: "png" });
	check("结果保存的是 png 直链", /\.png\)/.test(edits[0] ?? ""), JSON.stringify(edits[0]));
	check("不显示分辨率", !/\d+×\d+/.test(edits[0] ?? ""));
}

// ---- 5. document + 非图片格式 ----
{
	const { sends, edits } = await run("document 非图片", baseMsg({ document: { file_id: "f", file_unique_id: "pdf1", file_name: "a.bin", mime_type: "image/jpeg", file_size: 5000 } }), { fileBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) });
	check("只回一条格式提示", sends.length === 1 && sends[0].includes("认不出这个图片格式"), JSON.stringify(sends));
	check("没有误报「正在上传」", !sends.some((s) => s.includes("正在上传")));
	check("没有多余编辑", edits.length === 0);
}

// ---- 6. 重复投递：第二次静默 ----
{
	const stateKv = makeKv();
	await run("第一次投递", baseMsg({ photo: [{ file_id: "f", file_unique_id: "dup1", width: 800, height: 600, file_size: 9000 }] }), { stateKv });
	const { sends, stateKv: kv2 } = await run("重投同一条", baseMsg({ photo: [{ file_id: "f", file_unique_id: "dup1", width: 800, height: 600, file_size: 9000 }] }), { stateKv });
	check("重投时不做任何回复", sends.length === 0, `实际 ${sends.length} 条`);
	const col = JSON.parse(await kv2.get("acfun:collection"));
	check("重投没有重复入库", col.images.length === 1, `实际 ${col.images.length} 张`);
	check("入库记录了字节数", col.images[0].size > 0, `size=${col.images[0].size}`);
}

// ---- 7. 本人文本/命令正常响应 ----
{
	const { sends } = await run("本人纯文本", baseMsg({ text: "hi" }));
	check("本人文本有回复", sends.length === 1 && sends[0].includes("梗图"), JSON.stringify(sends));

	const { sends: helpSends } = await run("本人 /help", baseMsg(cmd("/help")));
	check("/help 有回复", helpSends.length === 1 && helpSends[0].includes("可用命令"));
	check("/help 没有双星号", !/\*\*/.test(helpSends[0] ?? ""));

	const { sends: statusSends } = await run("本人 /status（空）", baseMsg(cmd("/status")));
	check("/status 空态提示", statusSends.length === 1 && statusSends[0].includes("没有收集"), JSON.stringify(statusSends));
}

// ---- 8. 满 9 张 → 发布动态，文案符合要求 ----
{
	const { sends } = await run(
		"第 9 张图触发发布",
		baseMsg({ photo: [{ file_id: "f", file_unique_id: "ninth", width: 800, height: 600, file_size: 9000 }] }),
		{
			seedCollection: {
				images: Array.from({ length: 8 }, (_, i) => ({
					url: `https://imgs.aixifan.com/newUpload/1_fake${i}.jpg`,
					width: 800, height: 600, size: 9000, fileId: `f${i}`, at: Date.now(),
				})),
				chatId: OWNER,
			},
		},
	);
	const published = sends.find((s) => s.includes("新动态已发布")) ?? "";
	check("发布文案为「🎉 新动态已发布 · 查看」", /🎉 \*新动态已发布\* · \[查看\]\(https:\/\/m\.acfun\.cn\//.test(published), JSON.stringify(published));
	check("不再出现「已发布 9 图动态」", !sends.some((s) => s.includes("9 图动态")));
	check("不再出现「在 AcFun 查看」", !sends.some((s) => s.includes("在 AcFun 查看")));
}

console.log(`\n${pass ? "✅ 全部通过" : "❌ 有失败项"}`);
process.exitCode = pass ? 0 : 1;
}

main();
