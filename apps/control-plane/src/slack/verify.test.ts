import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify.js";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";
const body = '{"type":"event_callback","event":{"type":"app_mention"}}';
const sign = (ts: string, b = body, s = secret) => "v0=" + createHmac("sha256", s).update(`v0:${ts}:${b}`).digest("hex");

describe("verifySlackSignature", () => {
  const now = 1_700_000_000;
  it("accepts a valid signature", () => {
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sign(String(now)), rawBody: body, nowSec: now })).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sign(String(now)), rawBody: body + " ", nowSec: now })).toBe(false);
  });
  it("rejects replay older than 5 minutes", () => {
    const old = String(now - 301);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: old, signature: sign(old), rawBody: body, nowSec: now })).toBe(false);
  });
  it("rejects wrong secret and missing headers", () => {
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sign(String(now), body, "x"), rawBody: body, nowSec: now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: undefined, signature: undefined, rawBody: body, nowSec: now })).toBe(false);
  });
});
