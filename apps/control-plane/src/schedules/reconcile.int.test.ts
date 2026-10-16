import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Employee } from "@ai-employee/core";
import { EmployeeSchema } from "@ai-employee/core";
import { Ledger } from "../db/ledger.js";
import { resetTestDatabases, TEST_DB_URL } from "../test-support.js";
import { reconcileSchedules } from "./reconcile.js";

const deliverTo = { channel: "clickup-chat" as const, threadRef: "chan-1" };
const mk = (schedules?: Record<string, unknown>): Employee =>
  EmployeeSchema.parse({ id: "dev", name: "Dev", defaultRole: "r", roles: [{ id: "r" }, { id: "manager" }], ...(schedules ? { schedules } : {}) });
const nightly = { cron: "0 1 * * *", timezone: "America/Los_Angeles", role: "manager", prompt: "go", deliverTo };

describe("reconcileSchedules", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  const run = (e: Employee, now = new Date("2026-10-15T12:00:00Z")) => reconcileSchedules({ ledger, employees: new Map([[e.id, e]]), defaultTz: "UTC", now });
  const rows = async () => (await ledger.listSchedules("dev")).sort((a, b) => a.name.localeCompare(b.name));

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee("dev", "Dev");
  });
  afterAll(() => pool.end());

  it("inserts a config schedule with next_fire_at", async () => {
    await run(mk({ nightly }));
    const [r] = await rows();
    expect(r).toMatchObject({ name: "nightly", source: "config", role_id: "manager", timezone: "America/Los_Angeles", enabled: true });
    expect(r!.next_fire_at.toISOString()).toBe("2026-10-16T08:00:00.000Z"); // 01:00 PDT
  });

  it("a second run with the same definition is a no-op (last_fired_at kept)", async () => {
    const [before] = await rows();
    await ledger.markFired(before!.id, new Date("2026-10-16T08:00:00Z"), new Date("2026-10-17T08:00:00Z"));
    await run(mk({ nightly }), new Date("2026-10-16T09:00:00Z"));
    const [after] = await rows();
    expect(after!.last_fired_at?.toISOString()).toBe("2026-10-16T08:00:00.000Z");
    expect(after!.next_fire_at.toISOString()).toBe("2026-10-17T08:00:00.000Z");
    expect(after!.id).toBe(before!.id);
  });

  it("a changed cron updates the row and recomputes next_fire_at", async () => {
    await run(mk({ nightly: { ...nightly, cron: "0 2 * * *" } }), new Date("2026-10-16T09:00:00Z"));
    const [r] = await rows();
    expect(r!.cron).toBe("0 2 * * *");
    expect(r!.next_fire_at.toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  it("a runtime schedule with another name is untouched; removing the config one deletes only it", async () => {
    await ledger.createSchedule({ employeeId: "dev", name: "mine", cron: "0 9 * * *", timezone: "UTC", roleId: "r", prompt: "p", deliverTo, nextFireAt: new Date() });
    await run(mk());
    expect((await rows()).map((r) => [r.name, r.source])).toEqual([["mine", "runtime"]]);
  });

  it("a same-name runtime row becomes config", async () => {
    await run(mk({ mine: { ...nightly, cron: "0 3 * * *" } }));
    expect((await rows()).map((r) => [r.name, r.source, r.cron])).toEqual([["mine", "config", "0 3 * * *"]]);
  });

  it("falls back to the default timezone", async () => {
    await run(mk({ mine: { ...nightly, timezone: undefined } }));
    expect((await rows())[0]!.timezone).toBe("UTC");
  });

  it("refuses a schedule that would not run", async () => {
    await expect(run(mk({ bad: { ...nightly, cron: "* * * * *" } }))).rejects.toThrow(/15 minutes/);
    await expect(run(mk({ bad: { ...nightly, role: "ghost" } }))).rejects.toThrow(/unknown role/);
  });

  it("a telegram schedule without a chat is stored with an empty threadRef (resolved to the owner chat when it fires)", async () => {
    await run(mk({ nightly, tgdigest: { ...nightly, deliverTo: { channel: "telegram" } } }));
    const r = (await rows()).find((x) => x.name === "tgdigest")!;
    expect(r.deliver_to).toEqual({ channel: "telegram", threadRef: "" });
  });
});
