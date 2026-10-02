import { describe, expect, it } from "vitest";
import { nextFire, validateCron } from "./cron.js";

describe("nextFire", () => {
  it("returns the next occurrence strictly after `from`, in the given tz", () => {
    // 2026-03-01T12:00:00Z is 04:00 PST; the next 9am America/Los_Angeles (PST, UTC-8) is later the same day, 17:00 UTC.
    const next = nextFire("0 9 * * *", "America/Los_Angeles", new Date("2026-03-01T12:00:00Z"));
    expect(next.toISOString()).toBe("2026-03-01T17:00:00.000Z");
  });
});

describe("validateCron", () => {
  it("accepts a cron that fires at least 15 minutes apart", () => {
    const r = validateCron("*/15 * * * *", "UTC");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextTwo[1]!.getTime() - r.nextTwo[0]!.getTime()).toBe(15 * 60 * 1000);
  });

  it("rejects a cron firing more often than every 15 minutes", () => {
    const r = validateCron("*/5 * * * *", "UTC");
    expect(r).toEqual({ ok: false, error: "cron must fire at least 15 minutes apart" });
  });

  it("rejects a malformed cron expression", () => {
    const r = validateCron("not a cron", "UTC");
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown timezone", () => {
    const r = validateCron("0 * * * *", "Not/AZone");
    expect(r.ok).toBe(false);
  });

  it("respects timezone in the interval check (a DST-crossing hourly cron is still ~an hour apart)", () => {
    const r = validateCron("0 * * * *", "America/Los_Angeles");
    expect(r.ok).toBe(true);
  });
});
