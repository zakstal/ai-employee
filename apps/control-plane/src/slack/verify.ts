import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack request signing: v0 = HMAC-SHA256(secret, `v0:${timestamp}:${rawBody}`).
 * Rejects timestamps older than 5 minutes (replay window).
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string | Buffer;
  nowSec?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false;
  const base = `v0:${timestamp}:${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
