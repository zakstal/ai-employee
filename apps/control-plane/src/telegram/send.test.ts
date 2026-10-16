import { describe, expect, it } from "vitest";
import { NoopTelegramClient } from "./client.js";
import { deliverTelegram, splitMessage, TELEGRAM_LIMIT } from "./send.js";

describe("splitMessage", () => {
  it("leaves short text alone", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
  });
  it("splits long text into chunks within the limit, losing nothing", () => {
    const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(parts.join("\n")).toBe(text);
  });
  it("hard-splits text with no break points", () => {
    const parts = splitMessage("x".repeat(TELEGRAM_LIMIT * 2 + 5));
    expect(parts.map((p) => p.length)).toEqual([TELEGRAM_LIMIT, TELEGRAM_LIMIT, 5]);
  });
});

describe("deliverTelegram", () => {
  it("edits the placeholder in place, then sends the overflow as new messages", async () => {
    const c = new NoopTelegramClient();
    const ph = await c.sendMessage("111", "…");
    await deliverTelegram(c, "111", `${"a".repeat(TELEGRAM_LIMIT)}\n${"b".repeat(10)}`, ph);
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]).toMatchObject({ id: ph, text: "a".repeat(TELEGRAM_LIMIT) });
    expect(c.messages[1]!.text).toBe("b".repeat(10));
  });
  it("posts a new message when there is no placeholder, or the edit fails", async () => {
    const c = new NoopTelegramClient();
    await deliverTelegram(c, "111", "answer");
    expect(c.messages.map((m) => m.text)).toEqual(["answer"]);
    c.editMessageText = async () => {
      throw new Error("gone");
    };
    await deliverTelegram(c, "111", "again", "t1");
    expect(c.messages.map((m) => m.text)).toEqual(["answer", "again"]);
  });
});
