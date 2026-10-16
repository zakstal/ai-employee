import { describe, expect, it } from "vitest";
import { runTelegramAdmin } from "./admin.js";

const env = { TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_WEBHOOK_SECRET: "fake-secret", PUBLIC_BASE_URL: "https://ae.example.com/" };
function fakeFetch(result: unknown = true) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe("telegram admin CLI", () => {
  it("set-webhook sends url, secret_token and allowed_updates", async () => {
    const { calls, f } = fakeFetch();
    const out = await runTelegramAdmin("set-webhook", env, f);
    expect(calls).toEqual([{ url: "https://api.telegram.org/botfake-telegram-token/setWebhook", body: { url: "https://ae.example.com/webhooks/telegram", secret_token: "fake-secret", allowed_updates: ["message"] } }]);
    expect(out).toBe("webhook set: https://ae.example.com/webhooks/telegram");
    expect(out).not.toContain("fake-secret");
  });
  it("set-webhook refuses a missing secret or a non-https base", async () => {
    const { calls, f } = fakeFetch();
    await expect(runTelegramAdmin("set-webhook", { ...env, TELEGRAM_WEBHOOK_SECRET: "" }, f)).rejects.toThrow(/SECRET/);
    await expect(runTelegramAdmin("set-webhook", { ...env, PUBLIC_BASE_URL: "http://localhost:3000" }, f)).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });
  it("info and delete-webhook call getWebhookInfo / deleteWebhook", async () => {
    const { calls, f } = fakeFetch({ url: "https://x", pending_update_count: 0 });
    expect(await runTelegramAdmin("info", env, f)).toContain("pending_update_count");
    expect(await runTelegramAdmin("delete-webhook", env, f)).toBe("webhook deleted");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["getWebhookInfo", "deleteWebhook"]);
  });
  it("prints usage for an unknown command", async () => {
    await expect(runTelegramAdmin("nope", env, fakeFetch().f)).rejects.toThrow(/usage/);
  });
});
