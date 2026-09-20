import { Telegraf } from "telegraf";

import type { Config } from "../config";
import { flushIfReady } from "../services/poster";
import { logger } from "../utils/logger";
import { registerCommands } from "./commands";
import { handlePhoto, type PhotoDeps } from "./photo";

export interface BotDeps {
	/** 状态 KV；同时也是 acPasstoken 的来源（同一个 cloud-mail namespace） */
	stateKv: KVNamespace;
	cookieOverride?: string;
	ownerChatId?: number;
}

export class Bot {
	private config: Config;
	private telegraf: Telegraf;
	private deps: BotDeps;

	constructor(config: Config, deps: BotDeps) {
		this.config = config;
		this.deps = deps;
		// apiRoot 只有离线测试会传；生产走 Telegraf 默认的 api.telegram.org
		this.telegraf = new Telegraf(
			config.botToken,
			config.apiRoot ? { telegram: { apiRoot: config.apiRoot } } : undefined,
		);

		// 照片处理器必须先注册，否则会被 commands.ts 里的 `on("message")` 兜底吃掉。
		// 两种来源都收：`photo`（压缩图）与 `document`（转发时常见，保留原图）。
		this.telegraf.on("photo", (ctx) => handlePhoto(ctx, this.photoDeps()));
		this.telegraf.on("document", (ctx) => handlePhoto(ctx, this.photoDeps()));

		registerCommands(this.telegraf, {
			stateKv: deps.stateKv,
			ownerChatId: deps.ownerChatId,
			cookieOverride: deps.cookieOverride,
			flush: (content) => this.flush(content),
		});
	}

	private photoDeps(): PhotoDeps {
		return {
			stateKv: this.deps.stateKv,
			cookieOverride: this.deps.cookieOverride,
			ownerChatId: this.deps.ownerChatId,
		};
	}

	/** 跑一次发帖流程，结果直接由 poster 通过 Telegram 回报。 */
	async flush(content?: string): Promise<void> {
		await flushIfReady({
			stateKv: this.deps.stateKv,
			cookieOverride: this.deps.cookieOverride,
			notify: async (chatId, text) => {
				await this.notify(chatId, text);
			},
		}, { content });
	}

	/**
	 * Register the webhook URL with Telegram.
	 * Automatically skips if the webhook is already set to the correct URL.
	 */
	async setupWebhook(workerUrl: string): Promise<void> {
		try {
			const webhookUrl = `${workerUrl.replace("http://", "https://")}/webhook`;
			const webhookInfo = await this.telegraf.telegram.getWebhookInfo();
			logger.info("Webhook 状态", {
				current: webhookInfo.url || "(未设置)",
				pending: webhookInfo.pending_update_count,
				lastError: webhookInfo.last_error_message,
			});

			if (webhookInfo.url !== webhookUrl) {
				logger.info(`Setting up webhook: ${webhookUrl}`);
				await this.telegraf.telegram.deleteWebhook();
				await this.telegraf.telegram.setWebhook(webhookUrl);
				logger.info("Webhook set successfully");
			} else {
				logger.info("Webhook already set correctly");
			}
		} catch (error) {
			logger.error("Webhook setup error", error);
			throw error;
		}
	}

	/**
	 * Process an incoming Telegram update (from the webhook POST body).
	 */
	async handleWebhook(update: any): Promise<void> {
		try {
			await this.telegraf.handleUpdate(update);
		} catch (error) {
			logger.error("Webhook handling error", error);
			throw error;
		}
	}

	/** 发一条 Telegram 消息。 */
	async notify(chatId: number, text: string): Promise<void> {
		await this.telegraf.telegram.sendMessage(chatId, text);
	}

	/**
	 * Access the underlying Telegraf Telegram API client.
	 * Useful for sending messages, managing chats, etc.
	 */
	get telegram() {
		return this.telegraf.telegram;
	}
}
