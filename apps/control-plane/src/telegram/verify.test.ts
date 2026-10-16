import { describe, expect, it } from "vitest";
import { verifyTelegramSecret } from "./verify.js";

describe("verifyTelegramSecret", () => {
  it("accepts the exact secret", () => {
    expect(verifyTelegramSecret({ secret: "fake-secret-1", header: "fake-secret-1" })).toBe(true);
  });
  it("rejects a wrong, missing, or different-length header", () => {
    expect(verifyTelegramSecret({ secret: "fake-secret-1", header: "fake-secret-2" })).toBe(false);
    expect(verifyTelegramSecret({ secret: "fake-secret-1", header: "fake-secret-11" })).toBe(false);
    expect(verifyTelegramSecret({ secret: "fake-secret-1", header: undefined })).toBe(false);
  });
  it("rejects everything when no secret is configured", () => {
    expect(verifyTelegramSecret({ secret: "", header: "" })).toBe(false);
    expect(verifyTelegramSecret({ secret: "", header: "x" })).toBe(false);
  });
});
