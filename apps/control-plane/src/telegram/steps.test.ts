import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunExit, TaskInput } from "@ai-employee/core";
import { acknowledge, postResult, waitForExit } from "../orchestration/steps.js";
import { setWorkflowDeps } from "../orchestration/deps.js";
import { NoopTelegramClient } from "./client.js";

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
