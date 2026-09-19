/**
 * 时间格式化。
 *
 * Worker 里的 `Date` 永远是 UTC，而 `toLocaleString` 的时区支持取决于运行时的 ICU 数据，
 * 在 Workers 上不可靠。所以这里用「先偏移再按 UTC 格式化」的土办法 —— 不依赖 ICU，
 * 结果确定。
 */

/** 北京时间的 UTC 偏移（分钟）。 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 把毫秒时间戳格式化成北京时间的 `MM-DD HH:mm`。
 * 不显示年份：这个 Bot 的时间跨度最多几天，年份是噪音。
 */
export function formatBeijingTime(timestamp: number): string {
	const d = new Date(timestamp + BEIJING_OFFSET_MINUTES * 60 * 1000);
	return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
