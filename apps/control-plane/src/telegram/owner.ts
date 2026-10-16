import type { Config } from "../config.js";

/** The owner's Telegram chat: OWNER_TELEGRAM_CHAT_ID, else the first allowed chat. Undefined when Telegram is off or no chat is known. */
export function ownerChatId(config: Pick<Config, "TELEGRAM_BOT_TOKEN" | "OWNER_TELEGRAM_CHAT_ID" | "TELEGRAM_ALLOWED_CHAT_IDS">): string | undefined {
  if (!config.TELEGRAM_BOT_TOKEN) return undefined;
  return config.OWNER_TELEGRAM_CHAT_ID || config.TELEGRAM_ALLOWED_CHAT_IDS?.[0] || undefined;
}
