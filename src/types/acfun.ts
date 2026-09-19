/** AcFun 侧的领域类型。协议细节见 acfun-test/接口说明.md。 */

/** 已上传到 AcFun、拿到持久直链的一张图。 */
export interface AcfunImage {
	/** https://imgs.aixifan.com/newUpload/<uid>_<hash>.jpg —— 长期有效，匿名可访问 */
	url: string;
	width: number;
	height: number;
	/** 字节数。AcFun 不压缩，所以这就是原图大小 */
	size: number;
	/** Telegram file_unique_id，用于幂等去重与日志追踪 */
	fileId: string;
	/** 上传完成时间戳（ms） */
	at: number;
}

/** 待上传队列里的一批照片（同一 media_group 合并成一批） */
export interface PendingPhoto {
	fileId: string;
	fileUniqueId: string;
	width: number;
	height: number;
}

/** KV 中的收集状态。 */
export interface Collection {
	images: AcfunImage[];
	/** 收集来源的 Telegram chat id —— 让状态自带收件人，发帖端不需要额外入参 */
	chatId?: number;
	/** 上次发起发帖的时间戳（ms），用作并发闸防止重复发帖 */
	postingAt?: number;
}
