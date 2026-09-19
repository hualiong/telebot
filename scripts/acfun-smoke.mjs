// AcFun 链路冒烟测试 —— 可选的排查工具，平时用不到。
//
// 零依赖、零构建，直接跑（本机需能访问 acfun.cn，不需要代理）：
//
//   node scripts/acfun-smoke.mjs "<acPasstoken>" [图片路径] [--post]
//
// acPasstoken 从 KV 里取（cloud-mail namespace，key = `token`）：
//   npx wrangler kv key get --namespace-id 441e17faef8e4a66b6f7b6fb04b9363f token --remote
//
// 步骤：登录态探测 → 取上传凭证 → 分片上传 → 换持久直链 → 匿名校验 →（可选）发动态

const TOKEN = process.argv[2];
const IMG = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
const DO_POST = process.argv.includes("--post");

if (!TOKEN) {
	console.error('用法: node scripts/acfun-smoke.mjs "<acPasstoken>" [图片路径] [--post]');
	process.exit(1);
}

const PC = "https://member.acfun.cn";
const APP = "https://api-ipv6.acfunchina.com";
const KS = "https://upload.kuaishouzt.com";
const FRAGMENT = 1048576;
const UID = "57378037";
const COOKIE = `auth_key=${UID}; acPasstoken=${TOKEN}`;

const APP_QUERY =
	"market=tencent&product=ACFUN_APP&sys_version=16&app_version=7.10.0.1328" +
	"&boardPlatform=msmnile&sys_name=android&socName=Qualcomm%20Snapdragon%208150&appMode=0";

const UA = "acvideo core/7.10.0.1328(Huawei;Redmi K20 Pro;16) aegon/1.39.2-1-g3de73b77-curl";

const appHeaders = () => ({
	"User-Agent": UA,
	Cookie: COOKIE,
	appVersion: "7.10.0.1328",
	uid: UID,
	mod: "HUAWEI(Redmi K20 Pro)",
	gid: "DFPB517842ADE6621D46EE215D7B3E31699980B5B8D211FDB8EF4021C2699EF1",
	random_id: "adcc8325-a7ce-47f0-bf7e-d0dd9df80bd6",
	uuid: "b9bdc918-cd82-4ecc-ad1f-112f3a9f2998",
	udid: "9fe9a8b9-216f-34a4-9726-87f31c40ecf7",
	androidId: "084f11bb9929caeb",
	oaid: "00000000-0000-0000-0000-000000000000",
	acPlatform: "ANDROID_PHONE",
	isp: "CMCC",
	net: "WIFI",
	language: "zh-cn",
	resolution: "1080x2340",
	deviceType: "1",
	isChildPattern: "false",
	productId: "2000",
	market: "tencent",
	did_tag: "1",
	npr: "0",
	url_page: "DYNAMIC",
	"X-Client-Info": "model=Redmi K20 Pro;os=Android;nqe-score=25;network=WIFI;",
	random: crypto.randomUUID(),
	requestTime: new Date().toISOString().replace("T", " ").slice(0, 23),
	token: btoa(
		String.fromCharCode(0x08, 0x01, 0x12, 13, ...new TextEncoder().encode(String(Date.now()))),
	),
});

const ok = (s) => console.log(`  ✅ ${s}`);
const fail = (s) => {
	console.log(`  ❌ ${s}`);
	process.exitCode = 1;
};

// ---- 0. 登录态 ----
console.log("\n[0] 登录态探测 personalInfo");
{
	const r = await fetch(`${APP}/rest/app/user/personalInfo?${APP_QUERY}`, {
		headers: appHeaders(),
	});
	const j = await r.json();
	if (j.result === 0) ok(`凭证有效 (HTTP ${r.status})`);
	else {
		fail(`凭证无效: result=${j.result} ${j.error_msg ?? ""}`);
		console.log("\n凭证不可用，后续步骤无意义，已中止。");
		process.exit(1);
	}
}

if (!IMG) {
	console.log("\n未提供图片路径，到此为止。");
	process.exit(process.exitCode ?? 0);
}

// ---- 1~5. 上传 ----
const { readFile } = await import("node:fs/promises");
const { basename } = await import("node:path");

const bytes = new Uint8Array(await readFile(IMG));
const total = bytes.length;
const count = Math.ceil(total / FRAGMENT);
console.log(`\n图片: ${basename(IMG)}  ${total} 字节  分片数=${count}`);

const t0 = Date.now();

// ① getToken
const token = await (async () => {
	const fd = new FormData();
	fd.append("fileName", basename(IMG));
	const r = await fetch(`${PC}/rest/pc-direct/image/upload/getToken`, {
		method: "POST",
		headers: { Cookie: COOKIE, Referer: "https://member.acfun.cn/post-article", "User-Agent": UA },
		body: fd,
	});
	const j = await r.json();
	if (j.result !== 0) {
		fail(`getToken: result=${j.result} ${j.error_msg ?? ""}`);
		process.exit(1);
	}
	ok("① getToken");
	return j.info.token;
})();

// ② resume
{
	const r = await fetch(`${KS}/api/upload/resume?upload_token=${token}`, {
		headers: { "User-Agent": UA },
	});
	const j = await r.json();
	ok(`② resume (existed=${j.existed}, fragment_index=${j.fragment_index})`);
}

// ③ fragment × N
for (let i = 0; i < count; i++) {
	const start = i * FRAGMENT;
	const r = await fetch(`${KS}/api/upload/fragment?upload_token=${token}&fragment_id=${i}`, {
		method: "POST",
		headers: {
			"User-Agent": UA,
			"Content-Type": "application/octet-stream",
			// ⚠️ body 必须是裸字节，包成 multipart 会被拒
			"Content-Range": `bytes ${start}-${start + bytes.subarray(start, start + FRAGMENT).length - 1}/${total}`,
		},
		body: bytes.subarray(start, start + FRAGMENT),
	});
	const j = await r.json();
	if (j.result !== 1) {
		fail(`③ fragment#${i}: ${JSON.stringify(j).slice(0, 200)}`);
		process.exit(1);
	}
	ok(`③ fragment#${i} (${j.size} 字节)`);
}

// ④ complete
{
	const r = await fetch(
		`${KS}/api/upload/complete?fragment_count=${count}&upload_token=${token}`,
		{ method: "POST", headers: { "User-Agent": UA } },
	);
	const j = await r.json();
	if (j.result !== 1) {
		fail(`④ complete: ${JSON.stringify(j).slice(0, 200)}`);
		process.exit(1);
	}
	ok("④ complete");
}

// ⑤ 持久直链（必须 App 端点）
const url = await (async () => {
	const r = await fetch(`${APP}/rest/app/image/upload/getUrlAfterUpload?${APP_QUERY}`, {
		method: "POST",
		headers: { ...appHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token, bizFlag: "android-moment-text" }),
	});
	const j = await r.json();
	if (j.result !== 0) {
		fail(`⑤ getUrlAfterUpload: ${JSON.stringify(j).slice(0, 200)}`);
		process.exit(1);
	}
	if (/preview\./.test(j.url)) {
		fail(`⑤ 拿到 preview 链（端点用错了）: ${j.url}`);
		process.exit(1);
	}
	ok(`⑤ 持久直链: ${j.url}`);
	return j.url;
})();

// ---- 6. 匿名可下载性 ----
{
	const head = await fetch(url, { method: "HEAD" });
	const len = head.headers.get("content-length");
	if (head.status === 200 && Number(len) === total) ok(`⑥ 匿名下载 HTTP 200，字节数一致 (${len})`);
	else fail(`⑥ 匿名下载异常: HTTP ${head.status}, content-length=${len}, 期望 ${total}`);
}

console.log(`\n耗时 ${Date.now() - t0} ms`);

// ---- 7. 可选：发一条单图动态 ----
if (DO_POST) {
	console.log("\n[7] 发布动态 moment/add");
	const params = {
		content: "#无聊图##梗图##搞笑#",
		imgs: [{ url, width: 1280, height: 1199 }],
		visibleForFans: false,
	};
	const r = await fetch(`${APP}/rest/app/moment/add?${APP_QUERY}`, {
		method: "POST",
		headers: { ...appHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ params: JSON.stringify(params) }),
	});
	const j = await r.json();
	if (j.result === 0) {
		ok(`已发布 momentId=${j.moment.momentId}`);
		console.log(`     ${j.moment.shareUrl}`);
	} else if (j.result === 140011) {
		fail(`撞限流 140011（约 1 条 / 数分钟），稍后重试`);
	} else {
		fail(`result=${j.result} ${j.error_msg ?? ""} —— 原始响应: ${JSON.stringify(j).slice(0, 400)}`);
	}
}

console.log("");
