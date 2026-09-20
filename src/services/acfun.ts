import { logger } from "../utils/logger";

/**
 * AcFun 图片上传 + 发动态。
 *
 * 协议逆向细节与实测依据见 `acfun-test/接口说明.md`，这里是它的 TypeScript 移植。
 * 全链路只用 Web 标准 API（fetch / FormData / URLSearchParams / btoa / crypto），
 * 没有 Node 专有依赖，可以直接跑在 Workers 里。
 *
 * 一张图 = 5 个子请求（getToken → resume → fragment×N → complete → getUrlAfterUpload）。
 */

const PC = "https://member.acfun.cn";
const APP = "https://api-ipv6.acfunchina.com";
const KS = "https://upload.kuaishouzt.com";

/** 分片固定 1 MiB。Telegram 压缩照片几乎必然单分片，但仍按通用逻辑处理。 */
const FRAGMENT_SIZE = 1048576;

/**
 * 账号 uid。这条**不在 acPasstoken 里**（已实测：token 是裸 protobuf，不含 uid），
 * 所以只能作为常量。它就是 `auth_key` 的明文值，不是秘密。
 */
const UID = "57378037";

/** App 端点的设备指纹 query（常量，不是秘密）。 */
const APP_QUERY =
	"market=tencent&product=ACFUN_APP&sys_version=16&app_version=7.10.0.1328" +
	"&boardPlatform=msmnile&sys_name=android&socName=Qualcomm%20Snapdragon%208150&appMode=0";

const USER_AGENT =
	"acvideo core/7.10.0.1328(Huawei;Redmi K20 Pro;16) aegon/1.39.2-1-g3de73b77-curl";

/** 发动态触发服务端限流时的 result 码（约 1 条 / 数分钟）。 */
export const RESULT_RATE_LIMITED = 140011;

/** 发动态默认正文。 */
export const DEFAULT_CONTENT = "#无聊图##梗图##搞笑#";

/** 固定设备指纹头。全是生成值，不是秘密。 */
const fixedHeaders = () => ({
	"User-Agent": USER_AGENT,
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
});

/** 每请求现算的头（不保存）。 */
const dynamicHeaders = () => ({
	random: crypto.randomUUID(),
	requestTime: new Date().toISOString().replace("T", " ").slice(0, 23),
	// token = base64(protobuf{1:1, 2:"<13位毫秒时间戳>"})，已与抓包样本逐字节比对一致
	token: btoa(
		String.fromCharCode(
			0x08,
			0x01,
			0x12,
			13,
			...new TextEncoder().encode(String(Date.now())),
		),
	),
});

const appHeaders = (cookie: string) => ({
	Cookie: cookie,
	...fixedHeaders(),
	...dynamicHeaders(),
});

const pcHeaders = (cookie: string) => ({
	Cookie: cookie,
	Referer: "https://member.acfun.cn/post-article",
	"User-Agent": USER_AGENT,
});

/** 快手三跳不需要任何鉴权。 */
const ksHeaders = () => ({ "User-Agent": USER_AGENT });

export const buildCookie = (acPasstoken: string): string =>
	`auth_key=${UID}; acPasstoken=${acPasstoken}`;

/** 把 AcFun 的 result 码翻译成人话，便于回给 Telegram。 */
const describeFailure = (j: any): string => {
	if (j?.result === RESULT_RATE_LIMITED) return "触发限流(140011)，请稍后重试";
	if (j?.result === -401) return "凭证失效(-401)，acPasstoken 可能已过期";
	return `${j?.result ?? "?"} ${j?.error_msg ?? ""}`.trim();
};

/**
 * 取服务端响应里的**原始错误文案**，不做任何加工。
 *
 * `describeFailure()` 是给日志和 CLI 看的（它把 result 码拼在前面，比如
 * `27 服务器繁忙，请稍后再试`）；而 `error_msg` 本身就是给用户看的一句话
 * （限流时是「服务器繁忙，请稍后再试」）。用户界面上只该出现后者 ——
 * 于是这里把它单独摘出来挂在 Error 上，让消息层取用，而**不动 message 本身**，
 * 免得影响既有日志与 `acfun-smoke.mjs` 的输出。
 */
const rawMessageOf = (j: any): string | undefined =>
	typeof j?.error_msg === "string" && j.error_msg.trim() ? j.error_msg.trim() : undefined;

/**
 * 抛一个带「原始文案」的错误。沿用 `postMoment` 里既有的范式
 * （那边挂的是 `err.result`，这里挂 `err.rawMsg`）。
 */
function fail(prefix: string, j: any): never {
	const err: any = new Error(`${prefix}: ${describeFailure(j)}`);
	err.rawMsg = rawMessageOf(j);
	if (j?.result !== undefined) err.result = j.result;
	throw err;
}

/** ① 取上传凭证。PC 端点，multipart，只放 fileName。 */
async function getUploadToken(cookie: string, fileName: string): Promise<string> {
	const fd = new FormData();
	fd.append("fileName", fileName);
	const r = await fetch(`${PC}/rest/pc-direct/image/upload/getToken`, {
		method: "POST",
		headers: pcHeaders(cookie),
		body: fd,
	});
	const j: any = await r.json();
	if (j.result !== 0 || !j.info?.token) {
		fail("getToken 失败", j);
	}
	return j.info.token as string;
}

/** ② 断点续传探测（无鉴权）。全新上传返回 existed:false / fragment_index:-1。 */
async function resumeUpload(token: string): Promise<void> {
	const r = await fetch(`${KS}/api/upload/resume?upload_token=${token}`, {
		headers: ksHeaders(),
	});
	await r.json();
}

/**
 * ③ 上传分片。
 * ⚠️ body 必须是裸字节，绝不能包成 multipart；Content-Range 要手写；
 * Content-Length 由 runtime 自动推导，不要手写。
 */
async function uploadFragment(
	token: string,
	id: number,
	chunk: Uint8Array,
	start: number,
	total: number,
): Promise<void> {
	const r = await fetch(
		`${KS}/api/upload/fragment?upload_token=${token}&fragment_id=${id}`,
		{
			method: "POST",
			headers: {
				...ksHeaders(),
				"Content-Type": "application/octet-stream",
				"Content-Range": `bytes ${start}-${start + chunk.length - 1}/${total}`,
			},
			// Uint8Array 在运行时就是合法的 BodyInit；workers-types 的 BodyInit 联合类型
			// 认不出带 ArrayBufferLike 的泛型 Uint8Array，所以这里只能断言。
			// ⚠️ 绝对不要改成 FormData —— body 一旦被包成 multipart，服务端直接拒。
			body: chunk as unknown as BodyInit,
		},
	);
	const j: any = await r.json();
	if (j.result !== 1) {
		fail(`fragment ${id} 失败`, j);
	}
}

/** ④ 完成上传，fragment_count 必须等于实际分片数。 */
async function completeUpload(token: string, count: number): Promise<void> {
	const r = await fetch(
		`${KS}/api/upload/complete?fragment_count=${count}&upload_token=${token}`,
		{ method: "POST", headers: ksHeaders() },
	);
	const j: any = await r.json();
	if (j.result !== 1) {
		fail("complete 失败", j);
	}
}

/**
 * ⑤ 换持久直链 —— **必须用 App 端点**。
 * 用 PC 端点只会拿到 preview.ndcsk.com 的 3~4 小时过期链。
 */
async function getPersistentUrl(cookie: string, token: string): Promise<string> {
	const r = await fetch(`${APP}/rest/app/image/upload/getUrlAfterUpload?${APP_QUERY}`, {
		method: "POST",
		headers: { ...appHeaders(cookie), "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token, bizFlag: "android-moment-text" }),
	});
	const j: any = await r.json();
	if (j.result !== 0 || !j.url) {
		fail("getUrlAfterUpload 失败", j);
	}
	// 防御：拿到 preview 链就说明端点用错了，宁可直接报错也不要把会过期的链存进 KV
	if (/preview\./.test(j.url)) {
		throw new Error(`拿到 preview 链，不能用: ${j.url}`);
	}
	return j.url as string;
}

/**
 * 上传一张图，返回持久直链与尺寸。
 * 尺寸由调用方从 Telegram 的 photo 数组直接给出，不需要解析图片文件头。
 */
export async function uploadImage(
	cookie: string,
	bytes: Uint8Array,
	fileName: string,
): Promise<{ url: string; size: number }> {
	const token = await getUploadToken(cookie, fileName);
	await resumeUpload(token);

	const total = bytes.length;
	const count = Math.ceil(total / FRAGMENT_SIZE);
	for (let i = 0; i < count; i++) {
		const start = i * FRAGMENT_SIZE;
		await uploadFragment(
			token,
			i,
			bytes.subarray(start, start + FRAGMENT_SIZE),
			start,
			total,
		);
	}
	await completeUpload(token, count);

	const url = await getPersistentUrl(cookie, token);
	return { url, size: total };
}

export interface MomentResult {
	momentId: number;
	shareUrl: string;
	text: string;
}

/**
 * ⑥ 发一条动态。
 * ⚠️ params 必须用 URLSearchParams 编码，不能手拼 JSON 字符串。
 */
export async function postMoment(
	cookie: string,
	images: { url: string; width: number; height: number }[],
	content: string = DEFAULT_CONTENT,
): Promise<MomentResult> {
	if (images.length === 0) throw new Error("至少要有一张图");
	if (images.length > 9) throw new Error(`一次最多 9 张图，收到 ${images.length} 张`);
	for (const im of images) {
		if (/preview\./.test(im.url)) {
			throw new Error(`preview 链不能用（会过期）: ${im.url}`);
		}
	}

	const params = {
		content,
		// 服务端要求 {height, url, width}；顺序无关，但保持与抓包一致便于比对
		imgs: images.map((im) => ({
			height: im.height,
			url: im.url,
			width: im.width,
		})),
		visibleForFans: false,
	};

	const r = await fetch(`${APP}/rest/app/moment/add?${APP_QUERY}`, {
		method: "POST",
		headers: { ...appHeaders(cookie), "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ params: JSON.stringify(params) }),
	});
	const raw = await r.text();
	let j: any;
	try {
		j = JSON.parse(raw);
	} catch {
		throw new Error(`moment/add 返回非 JSON（HTTP ${r.status}）: ${raw.slice(0, 300)}`);
	}

	if (j.result !== 0) {
		// moment/add 失败时几乎没有额外信息，原始响应是唯一线索
		logger.error("moment/add 失败", { status: r.status, body: raw.slice(0, 800) });
		const err: any = new Error(`发动态失败: ${describeFailure(j)}`);
		err.result = j.result;
		throw err;
	}

	const shareUrl = j.moment?.shareUrl ?? `https://m.acfun.cn/communityCircle/moment/${j.moment?.momentId}`;
	logger.info("动态已发布", { momentId: j.moment?.momentId, shareUrl });
	return {
		momentId: j.moment?.momentId,
		shareUrl,
		text: j.moment?.text ?? content,
	};
}
