import { describe, expect, it } from "vitest";
import { HttpTelegramClient } from "./client.js";

function fakeFetch(result: unknown = { message_id: 42 }, status = 200, ok = true) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ ok, result, description: ok ? undefined : "Bad Request: chat not found" }), { status });
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe("HttpTelegramClient", () => {
  it("sendMessage posts plain text (no parse_mode) and returns the message id", async () => {
    const { calls, f } = fakeFetch();
    const id = await new HttpTelegramClient("fake-telegram-token", f).sendMessage("111", "hi *there*");
    expect(id).toBe("42");
    expect(calls[0]).toEqual({ url: "https://api.telegram.org/botfake-telegram-token/sendMessage", body: { chat_id: "111", text: "hi *there*" } });
  });
  it("editMessageText sends a numeric message_id", async () => {
    const { calls, f } = fakeFetch(true);
    await new HttpTelegramClient("fake-telegram-token", f).editMessageText("111", "42", "done");
    expect(calls[0]).toEqual({ url: "https://api.telegram.org/botfake-telegram-token/editMessageText", body: { chat_id: "111", message_id: 42, text: "done" } });
  });
  it("throws without echoing the token", async () => {
    const { f } = fakeFetch(undefined, 400, false);
    const err = await new HttpTelegramClient("fake-telegram-token", f).sendMessage("1", "x").catch((e: Error) => e);
    expect((err as Error).message).toContain("chat not found");
    expect((err as Error).message).not.toContain("fake-telegram-token");
  });
  it("throws when the token is unset", async () => {
    await expect(new HttpTelegramClient("", fakeFetch().f).sendMessage("1", "x")).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
