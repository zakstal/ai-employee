import { telegramCall } from "./client.js";

export const USAGE = `usage: telegram set-webhook | info | delete-webhook
env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL (set-webhook).
set-webhook points the bot at \${PUBLIC_BASE_URL}/webhooks/telegram (message updates only). Never runs at startup.`;

/** Runs one admin command and returns the text to print. Never prints the token or the secret. */
export async function runTelegramAdmin(cmd: string | undefined, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  if (cmd === "set-webhook") {
    const secret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const base = env.PUBLIC_BASE_URL ?? "";
    if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET unset");
    if (!/^https:\/\//.test(base)) throw new Error("PUBLIC_BASE_URL must be an https URL (Telegram only calls HTTPS webhooks)");
    const url = `${base.replace(/\/+$/, "")}/webhooks/telegram`;
    await telegramCall(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message"] }, fetchImpl);
    return `webhook set: ${url}`;
  }
  if (cmd === "info") {
    const i = await telegramCall<{ url?: string; pending_update_count?: number; last_error_message?: string; allowed_updates?: string[] }>(token, "getWebhookInfo", {}, fetchImpl);
    return JSON.stringify(i, null, 2);
  }
  if (cmd === "delete-webhook") {
    await telegramCall(token, "deleteWebhook", {}, fetchImpl);
    return "webhook deleted";
  }
  throw new Error(USAGE);
}
