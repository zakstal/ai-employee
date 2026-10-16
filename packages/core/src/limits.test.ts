import { describe, expect, it } from "vitest";
import { LIMIT_RE, parseLimitMessage } from "./limits.js";

const NOW = new Date("2026-10-16T12:00:00Z");

describe("parseLimitMessage", () => {
  it("parses the session-limit message with a UTC time-of-day, same day", () => {
    const hit = parseLimitMessage("You've hit your session limit · resets 5:40pm (UTC)", NOW);
    expect(hit).toEqual({ window: "5h", resetsAt: new Date("2026-10-16T17:40:00Z") });
  });

  it("rolls to the next day when the time already passed", () => {
    expect(parseLimitMessage("You've hit your session limit · resets 9am (UTC)", NOW)?.resetsAt).toEqual(new Date("2026-10-17T09:00:00Z"));
  });

  it("handles 12am / 12pm", () => {
    expect(parseLimitMessage("You've hit your session limit · resets 12am (UTC)", NOW)?.resetsAt).toEqual(new Date("2026-10-17T00:00:00Z"));
    expect(parseLimitMessage("You've hit your session limit · resets 12:30pm (UTC)", NOW)?.resetsAt).toEqual(new Date("2026-10-16T12:30:00Z"));
  });

  it("reads a 24-hour time", () => {
    expect(parseLimitMessage("You've hit your usage limit · resets 17:40 (UTC)", NOW)?.resetsAt).toEqual(new Date("2026-10-16T17:40:00Z"));
  });

  it("converts an IANA zone, honouring DST", () => {
    // 2026-10-16 is PDT (UTC-7)
    expect(parseLimitMessage("You've hit your session limit · resets 5pm (America/Los_Angeles)", NOW)?.resetsAt).toEqual(new Date("2026-10-17T00:00:00Z"));
    // 2026-12-01 is PST (UTC-8)
    expect(parseLimitMessage("You've hit your session limit · resets 5pm (America/Los_Angeles)", new Date("2026-12-01T12:00:00Z"))?.resetsAt).toEqual(new Date("2026-12-02T01:00:00Z"));
  });

  it("treats a missing zone as UTC", () => {
    expect(parseLimitMessage("You've hit your session limit · resets 6pm", NOW)?.resetsAt).toEqual(new Date("2026-10-16T18:00:00Z"));
  });

  it("reads a dated reset and marks the weekly limit as the 7d window", () => {
    const hit = parseLimitMessage("You've hit your weekly limit · resets Oct 20, 9am (UTC)", NOW);
    expect(hit).toEqual({ window: "7d", resetsAt: new Date("2026-10-20T09:00:00Z") });
  });

  it("rolls a dated reset that already passed to next year", () => {
    expect(parseLimitMessage("You've hit your weekly limit · resets Jan 2, 9am (UTC)", NOW)?.resetsAt).toEqual(new Date("2027-01-02T09:00:00Z"));
  });

  it("reads a relative reset", () => {
    expect(parseLimitMessage("You've hit your session limit · resets in 2h 15m", NOW)?.resetsAt).toEqual(new Date("2026-10-16T14:15:00Z"));
  });

  it("reads the legacy epoch form", () => {
    expect(parseLimitMessage("Claude usage limit reached. You've hit your usage limit|1792176600", NOW)?.resetsAt).toEqual(new Date(1792176600 * 1000));
  });

  it("matches a bare 'hit your limit' with no reset time", () => {
    expect(parseLimitMessage("You've hit your limit", NOW)).toEqual({ window: "5h", resetsAt: undefined });
  });

  it("keeps the hit but drops an unreadable time or unknown zone", () => {
    expect(parseLimitMessage("You've hit your session limit · resets soon", NOW)?.resetsAt).toBeUndefined();
    expect(parseLimitMessage("You've hit your session limit · resets 5pm (Mars/Olympus)", NOW)?.resetsAt).toBeUndefined();
    expect(parseLimitMessage("You've hit your session limit · resets 13pm (UTC)", NOW)?.resetsAt).toBeUndefined();
  });

  it("is not a limit message for ordinary text", () => {
    expect(parseLimitMessage("All done. Opened PR #12.", NOW)).toBeUndefined();
    expect(LIMIT_RE.test("rate limit exceeded")).toBe(false);
  });
});
