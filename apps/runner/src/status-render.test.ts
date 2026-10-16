import { describe, expect, it } from "vitest";
import { duration, renderStatus, type StatusBody } from "./status-render.js";

const body = (over: Partial<StatusBody> = {}): StatusBody => ({
  employee: "dev",
  now: "2026-10-16T12:00:00.000Z",
  currentTask: "telegram:9",
  active: [],
  finished: [],
  claude: { currentAccount: null, settings: { limitPolicy: "failover-then-wait", allowOverage: false, warnAt: 0.8, preferred: [] }, accounts: [] },
  ...over,
});
const task = (o: Partial<StatusBody["active"][number]> = {}): StatusBody["active"][number] => ({
  id: "telegram:5", role: "assistant", status: "running", channel: "telegram", parent: null, root: "telegram:5",
  startedAt: "2026-10-16T11:55:00.000Z", updatedAt: "2026-10-16T11:59:00.000Z", ageSec: 300, account: "work", costUsd: null, progress: "reading src/x.ts", ...o,
});

describe("duration", () => {
  it.each([[5, "5s"], [89, "89s"], [300, "5m"], [5400, "1h30m"], [5340, "89m"], [7260, "2h01m"], [200_000, "2d7h"]])("%d s -> %s", (s, out) => expect(duration(s)).toBe(out));
});

describe("renderStatus", () => {
  it("an idle employee: says so in every section", () => {
    const t = renderStatus(body());
    expect(t).toContain("dev @ 2026-10-16T12:00:00.000Z (this task: telegram:9)");
    expect(t).toContain("RUNNING NOW (0)\nnothing in flight");
    expect(t).toContain("FINISHED LAST 24H (0)\nnone");
    expect(t).toContain("none configured");
  });

  it("one row per active task: lineage, age, account, cost and the latest progress line", () => {
    const t = renderStatus(body({
      active: [
        task(),
        task({ id: "agent:telegram:5:abc", role: "dev", channel: "child", parent: "telegram:5", root: "telegram:5", ageSec: 7260, costUsd: 1.234, progress: "running tests" }),
        task({ id: "cron:1", channel: "cron", account: null, progress: null }),
        task({ id: "slack:2", status: "awaiting_input", progress: "ignored", question: "which branch?" }),
      ],
    }));
    expect(t).toContain("RUNNING NOW (4)");
    expect(t).toContain("telegram:5 | assistant | running | telegram | root | 5m | work | - | reading src/x.ts");
    expect(t).toContain("agent:telegram:5:abc | dev | running | child | telegram:5 / telegram:5 | 2h01m | work | $1.23 | running tests");
    expect(t).toContain("cron:1 | assistant | running | cron | root | 5m | - | - | (no output yet)");
    expect(t).toContain("slack:2 | assistant | awaiting_input | telegram | root | 5m | work | - | ASKS: which branch?");
  });

  it("a pipe in progress text cannot break the table", () => {
    expect(renderStatus(body({ active: [task({ progress: "a | b" })] }))).toContain("a / b");
  });

  it("finished tasks with status, cost and one-line result", () => {
    const t = renderStatus(body({ finished: [{ id: "cron:1", role: "ops", status: "failed", channel: "cron", finishedAt: "2026-10-16T11:00:00.000Z", costUsd: 0.5, result: "Task failed: boom" }, { id: "x", role: "ops", status: "done", channel: "http", finishedAt: "t", costUsd: null, result: "" }] }));
    expect(t).toContain("FINISHED LAST 24H (2)");
    expect(t).toContain("cron:1 | ops | failed | cron | 2026-10-16T11:00:00.000Z | $0.50 | Task failed: boom");
    expect(t).toContain("x | ops | done | http | t | - | -");
  });

  it("Claude section: policy line, this task's account, availability, windows, overage billing, probe errors", () => {
    const w = (u: number | null, r: string | null) => ({ utilization: u, resetsAt: r });
    const t = renderStatus(body({
      claude: {
        currentAccount: "work",
        settings: { limitPolicy: "wait", allowOverage: true, warnAt: 0.75, preferred: ["work", "personal"] },
        accounts: [
          { name: "work", available: true, fiveHour: w(0.29, "2026-10-16T15:00:00.000Z"), sevenDay: w(0.81, "2026-10-20T00:00:00.000Z"), overage: { status: "allowed", inUse: false }, checkedAt: "x", lastError: null },
          { name: "personal", available: false, availableAgainAt: "2026-10-16T18:00:00.000Z", fiveHour: w(1, "2026-10-16T18:00:00.000Z"), sevenDay: w(null, null), overage: { status: "allowed", inUse: true }, checkedAt: null, lastError: "network down" },
        ],
      },
    }));
    expect(t).toContain("CLAUDE ACCOUNTS (policy wait; overage allowed; warn at 75%; preferred work, personal)");
    expect(t).toContain("work (this task) | available | 5h 29% resets 2026-10-16T15:00:00.000Z | 7d 81% resets 2026-10-20T00:00:00.000Z\n");
    expect(t).toContain("personal | AT LIMIT until 2026-10-16T18:00:00.000Z | 5h 100% resets 2026-10-16T18:00:00.000Z | 7d ? resets ? | BILLING OVERAGE | probe error: network down");
  });
});
