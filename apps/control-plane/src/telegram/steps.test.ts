import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunExit, TaskInput } from "@ai-employee/core";
import { acknowledge, postResult, waitForExit } from "../orchestration/steps.js";
import { setWorkflowDeps } from "../orchestration/deps.js";
import { NoopTelegramClient } from "./client.js";
import { NoopClickUpClient } from "../clickup/client.js";

const input: TaskInput = { employeeId: "dev", roleId: "assistant", prompt: "hi", source: { channel: "telegram", threadRef: "111", messageRef: "5" } };
const exit: RunExit = { code: 0 };
const result = (text: string) => ({ type: "result", text, isError: false }) as never;

describe("telegram placeholder / result flow", () => {
  let tg: NoopTelegramClient;
  beforeEach(() => {
    tg = new NoopTelegramClient();
    setWorkflowDeps({ config: { ALERT_CHANNEL_ID: "" }, telegram: tg } as never);
  });
  afterEach(() => vi.useRealTimers());

  it("posts a placeholder, refreshes it every 3s, and the final answer replaces it", async () => {
    vi.useFakeTimers();
    const ack = await acknowledge(input);
    expect(ack).toMatchObject({ kind: "telegram", chatId: "111" });
    expect(tg.messages).toEqual([{ id: ack!.id, chatId: "111", text: "…" }]);

    let finish!: (e: RunExit) => void;
    setWorkflowDeps({ config: { ALERT_CHANNEL_ID: "" }, telegram: tg, runtimes: { k8s: { wait: () => new Promise<RunExit>((r) => (finish = r)) } } } as never);
    const waiting = waitForExit({ adapter: "k8s" } as never, ack);
    await vi.advanceTimersByTimeAsync(3100);
    expect(tg.messages[0]!.text).toMatch(/^[A-Za-z]+…$/);
    expect(tg.messages[0]!.text).not.toContain("*"); // plain text, no markdown
    finish(exit);
    await waiting;

    await postResult("t1", input, exit, result("the answer"), ack);
    expect(tg.messages).toHaveLength(1);
    expect(tg.messages[0]!.text).toBe("the answer");
  });

  it("splits a long answer: first chunk edits the placeholder, the rest are new messages", async () => {
    const ack = await acknowledge(input);
    await postResult("t1", input, exit, result("y".repeat(5000)), ack);
    expect(tg.messages).toHaveLength(2);
    expect(tg.messages.every((m) => m.text.length <= 4096)).toBe(true);
    expect(tg.messages.map((m) => m.text).join("")).toBe("y".repeat(5000));
  });

  it("quiet and child tasks get no placeholder", async () => {
    expect(await acknowledge({ ...input, source: { ...input.source, quiet: true } })).toBeUndefined();
    expect(tg.messages).toHaveLength(0);
  });
});

describe("alerts and report mirroring in postResult", () => {
  const failed = { type: "result", text: "boom", isError: true } as never;
  const tgCfg = { ALERT_CHANNEL_ID: "alerts", CLICKUP_TEAM_ID: "T", TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_ALLOWED_CHAT_IDS: ["7001"], OWNER_TELEGRAM_CHAT_ID: "" };
  const boot = (cfg: Record<string, unknown>) => {
    const tg = new NoopTelegramClient();
    const clickup = new NoopClickUpClient();
    setWorkflowDeps({ config: cfg, telegram: tg, clickup, slack: {} } as never);
    return { tg, clickup };
  };
  const httpInput: TaskInput = { employeeId: "dev", roleId: "ops", prompt: "p", source: { channel: "http" } };

  it("a failed http run alerts ClickUp, and the owner's Telegram chat only with ALERT_TELEGRAM", async () => {
    const off = boot(tgCfg);
    await postResult("t1", httpInput, { code: 1 }, failed);
    expect(off.clickup.chatMessages).toHaveLength(1);
    expect(off.clickup.chatMessages[0]!.text).toContain("ops run failed (t1): Task failed: boom");
    expect(off.tg.messages).toHaveLength(0);

    const on = boot({ ...tgCfg, ALERT_TELEGRAM: true });
    await postResult("t1", httpInput, { code: 1 }, failed);
    expect(on.clickup.chatMessages).toHaveLength(1);
    expect(on.tg.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: expect.stringContaining("ops run failed (t1)") }]);
  });

  it("a Telegram-only deployment alerts too; with no sink nothing is sent", async () => {
    const tgOnly = boot({ ...tgCfg, ALERT_CHANNEL_ID: "", ALERT_TELEGRAM: true });
    await postResult("t1", httpInput, { code: 1 }, failed);
    expect(tgOnly.tg.messages).toHaveLength(1);
    const none = boot({ ALERT_CHANNEL_ID: "" });
    await postResult("t1", httpInput, { code: 1 }, failed);
    expect(none.tg.messages).toHaveLength(0);
    expect(none.clickup.chatMessages).toHaveLength(0);
  });

  it("a monitor/manager report to the ClickUp alert channel is mirrored to Telegram under ALERT_TELEGRAM, never a NOISE verdict", async () => {
    const report: TaskInput = { employeeId: "dev", roleId: "manager", prompt: "p", source: { channel: "clickup-chat", threadRef: "alerts", quiet: true } };
    const on = boot({ ...tgCfg, ALERT_TELEGRAM: true });
    await postResult("m1", report, exit, result("two PRs need review"));
    expect(on.clickup.chatMessages.map((m) => m.text)).toEqual(["\u{1F916} two PRs need review"]);
    expect(on.tg.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: "two PRs need review" }]);
    await postResult("m2", report, exit, result("NOISE"));
    expect(on.tg.messages).toHaveLength(1);
    const off = boot(tgCfg);
    await postResult("m3", report, exit, result("two PRs need review"));
    expect(off.tg.messages).toHaveLength(0);
  });

  it("a quiet telegram-source task (replyTo / schedule) delivers just the final result, no placeholder", async () => {
    const t = boot(tgCfg);
    const input: TaskInput = { employeeId: "dev", roleId: "ops", prompt: "p", source: { channel: "telegram", threadRef: "7001", quiet: true } };
    expect(await acknowledge(input)).toBeUndefined();
    await postResult("t1", input, exit, result("the digest"));
    expect(t.tg.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: "the digest" }]);
    await postResult("t2", input, exit, result("NOISE"));
    expect(t.tg.messages).toHaveLength(1);
  });
});
