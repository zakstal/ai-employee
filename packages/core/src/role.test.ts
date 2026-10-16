import { describe, expect, it } from "vitest";
import { ScheduleSchema } from "./role.js";

const base = { cron: "0 9 * * *", role: "ops", prompt: "digest" };

describe("ScheduleSchema deliverTo", () => {
  it("telegram needs no threadRef (the owner's chat), and may name one", () => {
    expect(ScheduleSchema.parse({ ...base, deliverTo: { channel: "telegram" } }).deliverTo).toEqual({ channel: "telegram" });
    expect(ScheduleSchema.parse({ ...base, deliverTo: { channel: "telegram", threadRef: "7001" } }).deliverTo.threadRef).toBe("7001");
  });
  it("clickup channels still require a threadRef; unknown channels are rejected", () => {
    expect(() => ScheduleSchema.parse({ ...base, deliverTo: { channel: "clickup-chat" } })).toThrow(/threadRef/);
    expect(ScheduleSchema.parse({ ...base, deliverTo: { channel: "clickup", threadRef: "abc" } }).deliverTo.channel).toBe("clickup");
    expect(() => ScheduleSchema.parse({ ...base, deliverTo: { channel: "slack", threadRef: "x" } })).toThrow();
  });
});
