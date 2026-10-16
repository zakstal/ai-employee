import type { TaskSource } from "@ai-employee/core";
import type { Config } from "./config.js";
import type { ClickUpClient } from "./clickup/client.js";
import type { TelegramClient } from "./telegram/client.js";
import { deliverTelegram, splitMessage } from "./telegram/send.js";
import { ownerChatId } from "./telegram/owner.js";
import { BOT_MARKER } from "./clickup/chat.js";

export interface AlertDeps {
  config: Config;
  clickup: ClickUpClient;
  telegram?: TelegramClient | undefined;
}

/**
 * The one way the system tells the owner something happened. Posts to the ClickUp ALERT_CHANNEL_ID (when set) and,
 * with ALERT_TELEGRAM=1, to the owner's Telegram chat too. Never throws: each sink is best effort.
 * Returns true when at least one sink took it (callers that retry on failure key off this).
 */
export async function alert(d: AlertDeps, text: string): Promise<boolean> {
  const { config, clickup, telegram } = d;
  let delivered = false;
  if (config.ALERT_CHANNEL_ID) {
    try {
      await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, config.ALERT_CHANNEL_ID, text);
      delivered = true;
    } catch (e) {
      console.error("failed to post alert to ClickUp", e);
    }
  }
  const chat = config.ALERT_TELEGRAM && telegram ? ownerChatId(config) : undefined;
  if (chat && telegram) {
    try {
      await deliverTelegram(telegram, chat, text);
      delivered = true;
    } catch (e) {
      console.error("failed to post alert to Telegram", e);
    }
  }
  return delivered;
}

/** Whether alert() has anywhere to go; lets a caller skip work (a digest query) when it has not. */
export function alertConfigured(config: Config): boolean {
  return !!config.ALERT_CHANNEL_ID || (!!config.ALERT_TELEGRAM && !!ownerChatId(config));
}

export type OwnerSink = "telegram" | "clickup";

/** Message the owner directly: their Telegram chat, else (Telegram off) the ClickUp alert channel. Throws when neither exists or the send fails. */
export async function messageOwner(d: AlertDeps, text: string): Promise<{ channel: OwnerSink; parts: number }> {
  const { config, clickup, telegram } = d;
  const chat = ownerChatId(config);
  if (chat && telegram) {
    await deliverTelegram(telegram, chat, text);
    return { channel: "telegram", parts: splitMessage(text.trim()).length };
  }
  if (config.ALERT_CHANNEL_ID) {
    const parts = splitMessage(`${BOT_MARKER}${text}`);
    for (const p of parts) await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, config.ALERT_CHANNEL_ID, p);
    return { channel: "clickup", parts: parts.length };
  }
  throw new Error("no owner channel configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS, or ALERT_CHANNEL_ID)");
}

/** Where a machine-triggered task (monitor, manager wake) reports: the ClickUp alert channel; else, with ALERT_TELEGRAM, the owner's chat; else nowhere. */
export function alertSource(config: Config): TaskSource {
  if (config.ALERT_CHANNEL_ID) return { channel: "clickup-chat", threadRef: config.ALERT_CHANNEL_ID, quiet: true };
  const chat = config.ALERT_TELEGRAM ? ownerChatId(config) : undefined;
  return chat ? { channel: "telegram", threadRef: chat, quiet: true } : { channel: "http", quiet: true };
}
