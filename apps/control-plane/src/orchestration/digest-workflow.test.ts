import { describe, expect, it } from "vitest";
import type { Stats } from "../db/ledger.js";
import { buildDigest, crontabToUtc } from "./digest-workflow.js";

function stats(overrides: Partial<Stats> = {}): Stats {
  return {
    since: "2026-09-14T15:00:00.000Z",
    until: "2026-09-15T15:00:00.000Z",
    totals: { tasks: 5, done: 4, failed: 1, cancelled: 0, costUsd: 1.2345, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, numTurns: 20 },
    byDay: [],
    byRole: [{ role: "assistant", tasks: 5, done: 4, failed: 1, cancelled: 0, costUsd: 1.2345, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, numTurns: 20 }],
    byChannel: [],
    topTasks: [
      { id: "t1", role: "assistant", channel: "clickup", costUsd: 0.9, numTurns: 10, status: "done", prompt: "do the thing that takes a very long time to describe in detail" },
      { id: "t2", role: "ops", channel: "cron", costUsd: 0.3345, numTurns: 5, status: "failed", prompt: "short prompt" },
    ],
    ...overrides,
  };
}

describe("buildDigest", () => {
  it("formats header, totals, role breakdown, top tasks, and PR links", () => {
    const text = buildDigest(stats(), ["https://github.com/acme/repo/pull/42"]);
    expect(text).toContain("Daily digest — 2026-09-15");
    expect(text).toContain("5 tasks (4 done, 1 failed) · est. cost $1.2345 · 3000 tokens");
    expect(text).toContain("assistant: 5 (4 done, 1 failed, $1.2345)");
    expect(text).toContain("Top tasks by cost:");
    expect(text).toContain("- $0.9000 assistant/clickup: do the thing that takes a very long time to describe in de");
    expect(text).toContain("- $0.3345 ops/cron: short prompt");
    expect(text).toContain("PRs:");
    expect(text).toContain("- https://github.com/acme/repo/pull/42");
  });

  it("omits the PRs section when there are none", () => {
    expect(buildDigest(stats(), [])).not.toContain("PRs:");
  });

  it("omits top tasks and role sections when empty", () => {
    const text = buildDigest(stats({ byRole: [], topTasks: [] }), []);
    expect(text).not.toContain("Top tasks by cost:");
    expect(text.split("\n")).toHaveLength(2); // header + totals only
  });
});

describe("crontabToUtc", () => {
  it("converts a local hour to UTC using the tz offset at the given instant", () => {
    // America/Los_Angeles is UTC-8 in January (no DST) → 8am local = 16:00 UTC.
    expect(crontabToUtc("0 8 * * *", "America/Los_Angeles", new Date("2026-01-15T00:00:00Z"))).toBe("0 16 * * *");
    // UTC-7 in July (PDT) → 8am local = 15:00 UTC.
    expect(crontabToUtc("0 8 * * *", "America/Los_Angeles", new Date("2026-07-15T00:00:00Z"))).toBe("0 15 * * *");
  });

  it("leaves non-numeric hour fields untouched", () => {
    expect(crontabToUtc("*/15 * * * *", "America/Los_Angeles")).toBe("*/15 * * * *");
  });
});
