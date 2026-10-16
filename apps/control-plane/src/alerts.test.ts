import { describe, expect, it } from "vitest";
import { alert, alertConfigured, alertSource, messageOwner } from "./alerts.js";
import { loadConfig } from "./config.js";
import { NoopClickUpClient } from "./clickup/client.js";
import { NoopTelegramClient } from "./telegram/client.js";
import { ownerChatId } from "./telegram/owner.js";

const cfg = (env: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", CLICKUP_TEAM_ID: "T", ...env });
const TG = { TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_ALLOWED_CHAT_IDS: "7001,7002" };
const setup = (env: Record<string, string> = {}) => ({ config: cfg(env), clickup: new NoopClickUpClient(), telegram: new NoopTelegramClient() });

describe("ownerChatId", () => {
  it("is the first allowed chat, OWNER_TELEGRAM_CHAT_ID overrides, and Telegram off means none", () => {
    expect(ownerChatId(cfg(TG))).toBe("7001");
    expect(ownerChatId(cfg({ ...TG, OWNER_TELEGRAM_CHAT_ID: "7002" }))).toBe("7002");
    expect(ownerChatId(cfg({ TELEGRAM_ALLOWED_CHAT_IDS: "7001" }))).toBeUndefined(); // no bot token
    expect(ownerChatId(cfg({ TELEGRAM_BOT_TOKEN: "t" }))).toBeUndefined(); // no chat
  });
  it("rejects a non-numeric OWNER_TELEGRAM_CHAT_ID", () => {
    expect(() => cfg({ OWNER_TELEGRAM_CHAT_ID: "@me" })).toThrow(/numeric/);
  });
});

describe("alert", () => {
  it("unset flag: ClickUp only, exactly as before", async () => {
    const d = setup({ ...TG, ALERT_CHANNEL_ID: "alerts" });
    expect(await alert(d, "🤖 ⚠️ boom")).toBe(true);
    expect(d.clickup.chatMessages).toEqual([{ id: expect.any(String), channelId: "alerts", text: "🤖 ⚠️ boom" }]);
    expect(d.telegram.messages).toHaveLength(0);
  });

  it("ALERT_TELEGRAM=1: ClickUp and the owner's Telegram chat", async () => {
    const d = setup({ ...TG, ALERT_CHANNEL_ID: "alerts", ALERT_TELEGRAM: "1" });
    expect(await alert(d, "boom")).toBe(true);
    expect(d.clickup.chatMessages).toHaveLength(1);
    expect(d.telegram.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: "boom" }]);
  });

  it("accepts `true` too, goes to OWNER_TELEGRAM_CHAT_ID, and works with no ClickUp channel at all", async () => {
    const d = setup({ ...TG, ALERT_TELEGRAM: "true", OWNER_TELEGRAM_CHAT_ID: "7002" });
    expect(await alert(d, "boom")).toBe(true);
    expect(d.clickup.chatMessages).toHaveLength(0);
    expect(d.telegram.messages.map((m) => m.chatId)).toEqual(["7002"]);
  });

  it("splits a long alert for Telegram", async () => {
    const d = setup({ ...TG, ALERT_TELEGRAM: "1" });
    await alert(d, "x".repeat(5000));
    expect(d.telegram.messages).toHaveLength(2);
  });

  it("nothing configured, or the flag without a Telegram bot: no sink, returns false, nothing thrown", async () => {
    const none = setup();
    expect(await alert(none, "x")).toBe(false);
    expect(alertConfigured(none.config)).toBe(false);
    const flagOnly = setup({ ALERT_TELEGRAM: "1" });
    expect(await alert(flagOnly, "x")).toBe(false);
    expect(alertConfigured(flagOnly.config)).toBe(false);
  });

  it("the flag set but no telegram client passed: ClickUp still gets it", async () => {
    const d = setup({ ...TG, ALERT_CHANNEL_ID: "alerts", ALERT_TELEGRAM: "1" });
    expect(await alert({ config: d.config, clickup: d.clickup }, "x")).toBe(true);
    expect(d.clickup.chatMessages).toHaveLength(1);
  });

  it("one failing sink does not stop the other, and the result says whether anything was delivered", async () => {
    const d = setup({ ...TG, ALERT_CHANNEL_ID: "alerts", ALERT_TELEGRAM: "1" });
    d.clickup.postChannelMessage = async () => {
      throw new Error("clickup down");
    };
    expect(await alert(d, "x")).toBe(true);
    expect(d.telegram.messages).toHaveLength(1);
    d.telegram.sendMessage = async () => {
      throw new Error("telegram down");
    };
    expect(await alert(d, "x")).toBe(false);
  });

  it("alertConfigured: ClickUp channel, or the flag with an owner chat", () => {
    expect(alertConfigured(cfg({ ALERT_CHANNEL_ID: "a" }))).toBe(true);
    expect(alertConfigured(cfg({ ...TG, ALERT_TELEGRAM: "1" }))).toBe(true);
    expect(alertConfigured(cfg(TG))).toBe(false);
  });
});

describe("alertSource (where monitor / manager runs report)", () => {
  it("ClickUp channel first, else the owner chat under the flag, else nowhere", () => {
    expect(alertSource(cfg({ ALERT_CHANNEL_ID: "a" }))).toEqual({ channel: "clickup-chat", threadRef: "a", quiet: true });
    expect(alertSource(cfg({ ...TG, ALERT_TELEGRAM: "1" }))).toEqual({ channel: "telegram", threadRef: "7001", quiet: true });
    expect(alertSource(cfg(TG))).toEqual({ channel: "http", quiet: true });
    expect(alertSource(cfg())).toEqual({ channel: "http", quiet: true });
  });
});

describe("messageOwner", () => {
  it("Telegram when it is on", async () => {
    const d = setup({ ...TG, ALERT_CHANNEL_ID: "alerts" });
    expect(await messageOwner(d, "hello")).toEqual({ channel: "telegram", parts: 1 });
    expect(d.telegram.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: "hello" }]);
    expect(d.clickup.chatMessages).toHaveLength(0);
  });
  it("falls back to ClickUp, bot-marked, split when long", async () => {
    const d = setup({ ALERT_CHANNEL_ID: "alerts" });
    expect(await messageOwner(d, "y".repeat(5000))).toEqual({ channel: "clickup", parts: 2 });
    expect(d.clickup.chatMessages[0]!.text.startsWith("\u{1F916} ")).toBe(true);
    expect(d.telegram.messages).toHaveLength(0);
  });
  it("Telegram token without any chat id also falls back", async () => {
    const d = setup({ TELEGRAM_BOT_TOKEN: "t", ALERT_CHANNEL_ID: "alerts" });
    expect((await messageOwner(d, "x")).channel).toBe("clickup");
  });
  it("throws a clear error with no owner channel", async () => {
    await expect(messageOwner(setup(), "x")).rejects.toThrow(/no owner channel configured/);
  });
});
