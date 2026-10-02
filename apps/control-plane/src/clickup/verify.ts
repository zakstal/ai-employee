import { createHmac, timingSafeEqual } from "node:crypto";

/** ClickUp webhooks: X-Signature = hex(HMAC-SHA256(secret, rawBody)). */
export function verifyClickUpSignature(opts: { secret: string; signature: string | undefined; rawBody: string | Buffer }): boolean {
  if (!opts.secret || !opts.signature) return false;
  const expected = createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
