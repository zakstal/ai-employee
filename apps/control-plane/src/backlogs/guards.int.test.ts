import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BacklogSchema, EmployeeSchema, type Employee } from "@ai-employee/core";
import { NoopClickUpClient } from "../clickup/client.js";
import { NoopTelegramClient } from "../telegram/client.js";
import { loadConfig } from "../config.js";
import { Ledger } from "../db/ledger.js";
import { resetTestDatabases, TEST_DB_URL, TEST_DBOS_URL } from "../test-support.js";
import { afterBacklogTask, backlogOverview, checkDispatchGuards, dayStart } from "./guards.js";

const mk = (guards: Record<string, unknown>, concurrency = 2): Employee =>
  EmployeeSchema.parse({
    id: "dev", name: "Dev", defaultRole: "r", roles: [{ id: "r" }],
    backlogs: { bl: BacklogSchema.parse({ source: { kind: "clickup-list", listId: "L" }, dispatch: { role: "r", brief: "b" }, concurrency, guards }) },
  });

describe("flow guards", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  const clickup = new NoopClickUpClient();
  const config = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, ALERT_CHANNEL_ID: "alerts", CLICKUP_TEAM_ID: "T", DEFAULT_TZ: "UTC" });
  const d = () => ({ ledger, config, clickup });
  let n = 0;
  const mkTask = async (item: string, status: "queued" | "done" | "failed" | "cancelled", costUsd?: number) => {
    const id = `t${++n}`;
    const source = { channel: "child" as const, managedBy: "manager", backlogId: "bl", backlogItem: item };
    await ledger.createTask(id, { employeeId: "dev", roleId: "r", prompt: "p", source });
    if (status !== "queued") await ledger.setStatus(id, status, { result: costUsd !== undefined ? { costUsd } : {} });
    return { id, input: { employeeId: "dev", roleId: "r", prompt: "p", source } };
  };
  const reset = async () => {
    await pool.query("DELETE FROM tasks");
    await pool.query("DELETE FROM backlog_state");
    clickup.chatMessages.length = 0;
  };

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee("dev", "Dev");
  });
  afterAll(() => pool.end());

  it("dayStart is local midnight in the zone", () => {
    const r = dayStart("America/Los_Angeles", new Date("2026-10-15T09:30:00Z")); // 02:30 PDT
    expect([r.start.toISOString(), r.day]).toEqual(["2026-10-15T07:00:00.000Z", "2026-10-15"]);
  });

  it("concurrency 2 blocks the third dispatch (409 text), a finished task frees a slot", async () => {
    await reset();
    const e = mk({});
    await mkTask("a", "queued");
    expect(await checkDispatchGuards(d(), e, "bl", "x")).toBeUndefined();
    const b = await mkTask("b", "queued");
    expect(await checkDispatchGuards(d(), e, "bl", "x")).toBe("guard: concurrency (2/2)");
    await ledger.setStatus(b.id, "done");
    expect(await checkDispatchGuards(d(), e, "bl", "x")).toBeUndefined();
  });

  it("daily task budget blocks and alerts once", async () => {
    await reset();
    const e = mk({ maxTasksPerDay: 2 }, 5);
    await mkTask("a", "done");
    await mkTask("b", "done");
    expect(await checkDispatchGuards(d(), e, "bl", "c")).toBe("guard: daily budget: 2/2 tasks");
    expect(await checkDispatchGuards(d(), e, "bl", "c")).toBe("guard: daily budget: 2/2 tasks");
    expect(clickup.chatMessages.filter((m) => m.channelId === "alerts")).toHaveLength(1);
  });

  it("guard alerts also go to the owner's Telegram chat under ALERT_TELEGRAM=1", async () => {
    await reset();
    const tg = new NoopTelegramClient();
    const tgConfig = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, ALERT_CHANNEL_ID: "alerts", CLICKUP_TEAM_ID: "T", DEFAULT_TZ: "UTC", TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_ALLOWED_CHAT_IDS: "7001", ALERT_TELEGRAM: "1" });
    const e = mk({ maxTasksPerDay: 1 }, 5);
    await mkTask("a", "done");
    const before = clickup.chatMessages.length;
    expect(await checkDispatchGuards({ ledger, config: tgConfig, clickup, telegram: tg }, e, "bl", "c")).toBe("guard: daily budget: 1/1 tasks");
    expect(clickup.chatMessages.length - before).toBe(1);
    expect(tg.messages).toHaveLength(1);
    expect(tg.messages[0]).toMatchObject({ chatId: "7001" });
    expect(tg.messages[0]!.text).toContain("backlog bl");
  });

  it("daily cost budget blocks", async () => {
    await reset();
    const e = mk({ maxCostUsdPerDay: 10 }, 5);
    await mkTask("a", "done", 6);
    expect(await checkDispatchGuards(d(), e, "bl", "z")).toBeUndefined();
    await mkTask("b", "done", 4.5);
    expect(await checkDispatchGuards(d(), e, "bl", "z")).toBe("guard: daily budget: $10.50 of $10");
  });

  it("per-item attempts", async () => {
    await reset();
    const e = mk({ maxAttemptsPerItem: 2 }, 5);
    await mkTask("a", "failed");
    expect(await checkDispatchGuards(d(), e, "bl", "a")).toBeUndefined();
    await mkTask("a", "failed");
    expect(await checkDispatchGuards(d(), e, "bl", "a")).toBe("guard: item a used its 2 attempts");
    expect(await checkDispatchGuards(d(), e, "bl", "other")).toBeUndefined();
  });

  it("3 consecutive failures halt and alert once; halted blocks dispatch; resume clears and restarts the streak", async () => {
    await reset();
    const e = mk({}, 5);
    const emps = new Map([["dev", e]]);
    for (const item of ["a", "b"]) {
      const t = await mkTask(item, "failed");
      await afterBacklogTask(d(), emps, t.input);
    }
    expect(await ledger.getBacklogHalt("dev", "bl")).toBeUndefined();
    const third = await mkTask("c", "cancelled");
    await afterBacklogTask(d(), emps, third.input);
    await afterBacklogTask(d(), emps, third.input); // a re-run of the step must not alert twice
    expect((await ledger.getBacklogHalt("dev", "bl"))?.reason).toMatch(/^3 consecutive failures: /);
    expect(clickup.chatMessages.filter((m) => m.text.includes("halted after 3 consecutive failures"))).toHaveLength(1);
    expect(await checkDispatchGuards(d(), e, "bl", "d")).toMatch(/^guard: halted \(3 consecutive failures/);
    expect((await backlogOverview({ ledger, config }, e))[0]).toMatchObject({ halted: true, running: 0 });

    expect(await ledger.resumeBacklog("dev", "bl")).toBe(true);
    expect(await ledger.resumeBacklog("dev", "bl")).toBe(false);
    expect(await checkDispatchGuards(d(), e, "bl", "d")).toBeUndefined();
    const again = await mkTask("d", "failed"); // old failures no longer count: one is not three
    await afterBacklogTask(d(), emps, again.input);
    expect(await ledger.getBacklogHalt("dev", "bl")).toBeUndefined();
  });

  it("a done task between failures resets the streak", async () => {
    await reset();
    const e = mk({ stopAfterConsecutiveFailures: 3 }, 5);
    const emps = new Map([["dev", e]]);
    for (const status of ["failed", "failed", "done", "failed"] as const) await afterBacklogTask(d(), emps, (await mkTask(`i${++n}`, status)).input);
    expect(await ledger.getBacklogHalt("dev", "bl")).toBeUndefined();
  });

  it("tasks of a non-backlog source never halt anything", async () => {
    await reset();
    await afterBacklogTask(d(), new Map([["dev", mk({})]]), { employeeId: "dev", roleId: "r", prompt: "p", source: { channel: "http" } });
    expect(await ledger.getBacklogHalt("dev", "bl")).toBeUndefined();
  });
});
