import { beforeEach, describe, expect, it } from "vitest";
import type { ScheduleRow } from "../db/ledger.js";
import { setWorkflowDeps } from "../orchestration/deps.js";
import { taskFor } from "./tick.js";

const row = (deliver_to: ScheduleRow["deliver_to"]): ScheduleRow =>
  ({ id: "s1", employee_id: "dev", name: "n", cron: "0 9 * * *", timezone: "UTC", role_id: "ops", prompt: "digest", deliver_to, next_fire_at: new Date("2026-10-17T09:00:00Z") }) as ScheduleRow;
const cfg = { TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_ALLOWED_CHAT_IDS: ["7001", "7002"], OWNER_TELEGRAM_CHAT_ID: "" };

describe("schedule taskFor", () => {
  beforeEach(() => setWorkflowDeps({ config: cfg } as never));

  it("clickup-chat and clickup deliver as before", () => {
    expect(taskFor(row({ channel: "clickup-chat", threadRef: "ch" })).input.source).toEqual({ channel: "clickup-chat", threadRef: "ch", quiet: true });
    expect(taskFor(row({ channel: "clickup", threadRef: "abc" })).input.source).toEqual({ channel: "clickup", threadRef: "abc", quiet: true });
  });
  it("telegram delivers to the stored chat, quiet", () => {
    const { taskId, input } = taskFor(row({ channel: "telegram", threadRef: "7002" }));
    expect(taskId).toBe("cron:s1:2026-10-17T09:00:00.000Z");
    expect(input.source).toEqual({ channel: "telegram", threadRef: "7002", quiet: true });
  });
  it("telegram from a config schedule with no chat resolves to the owner chat at fire time", () => {
    expect(taskFor(row({ channel: "telegram", threadRef: "" })).input.source).toMatchObject({ channel: "telegram", threadRef: "7001" });
    setWorkflowDeps({ config: { ...cfg, OWNER_TELEGRAM_CHAT_ID: "7002" } } as never);
    expect(taskFor(row({ channel: "telegram", threadRef: "" })).input.source).toMatchObject({ threadRef: "7002" });
  });
  it("telegram turned off since: runs with nowhere to deliver (cron source, so a failure still alerts)", () => {
    setWorkflowDeps({ config: { ...cfg, TELEGRAM_BOT_TOKEN: "" } } as never);
    expect(taskFor(row({ channel: "telegram", threadRef: "" })).input.source).toEqual({ channel: "cron", quiet: true });
  });
});
