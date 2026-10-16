import { createHash, timingSafeEqual } from "node:crypto";

/** Telegram echoes the setWebhook secret_token in X-Telegram-Bot-Api-Secret-Token. Hashing first makes the compare constant-time for any length. */
export function verifyTelegramSecret(opts: { secret: string; header: string | undefined }): boolean {
  if (!opts.secret || !opts.header) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(opts.secret), h(opts.header));
}
