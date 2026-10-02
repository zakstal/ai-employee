import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyClickUpSignature } from "./verify.js";

describe("verifyClickUpSignature", () => {
  const secret = "whsec";
  const body = '{"event":"taskCommentPosted"}';
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("accepts valid", () => expect(verifyClickUpSignature({ secret, signature: sig, rawBody: body })).toBe(true));
  it("rejects tampered body", () => expect(verifyClickUpSignature({ secret, signature: sig, rawBody: body + " " })).toBe(false));
  it("rejects missing", () => expect(verifyClickUpSignature({ secret, signature: undefined, rawBody: body })).toBe(false));
});
