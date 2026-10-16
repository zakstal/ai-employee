/**
 * Claude accounts: /usage, /settings/claude, /agents/self/limit, /agents/self/usage, plus the launch-time pick and the
 * passive limit record. Same trimmed boot as messages.int.test.ts. Needs Postgres from `make dev`.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Employee, RunSpec, SandboxRuntime } from "@ai-employee/core";
import { loadConfig, type Config } from "../config.js";
import { Ledger } from "../db/ledger.js";
import { buildServer } from "./server.js";
import { NoopSlackClient } from "../slack/client.js";
import { NoopClickUpClient } from "../clickup/client.js";
import { resetTestDatabases, TEST_DB_URL, TEST_DBOS_URL } from "../test-support.js";
import { DbosOrchestrator } from "../orchestration/dbos-orchestrator.js";
import { ClaudeService } from "../claude/service.js";
import { setWorkflowDeps } from "../orchestration/deps.js";
import { EnvSecretStore } from "../credentials/index.js";
import * as steps from "../orchestration/steps.js";

const role = {
  id: "assistant", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
  maxTurns: 5, runtime: "k8s" as const, cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: ["claude-subscription"], repos: [],
  capabilities: [], canSchedule: [], canSpawn: [],
};
const employee: Employee = { id: "dev", name: "dev", defaultRole: "assistant", workstreams: {}, monitors: {}, roles: [role] };

const NOW = new Date("2026-10-16T12:00:00Z");
const epoch = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
const R5 = "2026-10-16T15:00:00Z";
const R7 = "2026-10-20T00:00:00Z";

/** Per-account headers the fake Anthropic returns; change `fake[name]` between probes. */
const fake: Record<string, Record<string, string> | "error"> = {};
const fakeFetch = (async (_url: string, init: RequestInit) => {
  const token = (init.headers as Record<string, string>).authorization!.slice(7);
  const name = Object.keys(TOKENS).find((n) => TOKENS[n] === token)!;
  const h = fake[name];
  if (h === "error" || !h) throw new Error("network down");
  return new Response("{}", { headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v])) });
}) as unknown as typeof fetch;

const TOKENS: Record<string, string> = { work: "sk-ant-WORKSECRET", personal: "sk-ant-PERSONALSECRET" };
const ok = (u5: number, u7 = 0.1, r5 = R5) => ({ status: "allowed", "5h-status": "allowed", "5h-utilization": String(u5), "5h-reset": epoch(r5), "7d-status": "allowed", "7d-utilization": String(u7), "7d-reset": epoch(R7), "overage-status": "rejected", "representative-claim": "five_hour" });
const out = (r5 = R5) => ({ ...ok(1), status: "rejected", "5h-status": "rejected" , "5h-reset": epoch(r5) });

describe("claude accounts", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  let config: Config;
  let clickup: NoopClickUpClient;
  let app: ReturnType<typeof buildServer>;
  let n = 0;

  async function agent(account?: string) {
    const taskId = `http:dev:t${++n}`;
    await ledger.createTask(taskId, { employeeId: "dev", roleId: "assistant", prompt: "noop", source: { channel: "http" } });
    if (account) await ledger.setTaskClaudeAccount(taskId, account);
    return { taskId, headers: { authorization: `Bearer ${await ledger.issueRunToken(taskId, 600)}`, "x-task-id": taskId } };
  }
  const putSettings = (payload: unknown) => app.inject({ method: "PUT", url: "/settings/claude", payload: payload as object });
  const limit = (headers: Record<string, string>, payload: unknown = {}) => app.inject({ method: "POST", url: "/agents/self/limit", headers, payload: payload as object });
  const refresh = () => app.inject({ method: "POST", url: "/usage/refresh" });

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee("dev", "dev");
    config = loadConfig({
      DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, ALERT_CHANNEL_ID: "alerts",
      CLAUDE_CODE_OAUTH_TOKEN_WORK: TOKENS.work!, CLAUDE_CODE_OAUTH_TOKEN_PERSONAL: TOKENS.personal!,
    } as NodeJS.ProcessEnv);
    clickup = new NoopClickUpClient();
    const claude = new ClaudeService({ config, ledger, clickup, fetch: fakeFetch, now: () => NOW });
    app = buildServer({ config, ledger, orchestrator: new DbosOrchestrator(ledger), employees: new Map([["dev", employee]]), slack: new NoopSlackClient(), clickup, claude });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM engine_settings");
    await pool.query("DELETE FROM claude_account_usage");
    clickup.chatMessages.length = 0;
    for (const k of Object.keys(fake)) delete fake[k];
  });

  describe("settings", () => {
    it("GET returns the defaults", async () => {
      const res = await app.inject({ method: "GET", url: "/settings/claude" });
      expect(res.json()).toEqual({ limitPolicy: "failover-then-wait", allowOverage: false, warnAt: 0.8, preferred: [] });
    });

    it("PUT merges a partial update, normalizes preferred, and persists", async () => {
      const res = await putSettings({ limitPolicy: "wait", preferred: ["Work", "work", "personal"] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ limitPolicy: "wait", allowOverage: false, warnAt: 0.8, preferred: ["work", "personal"] });
      await putSettings({ allowOverage: true });
      expect((await app.inject({ method: "GET", url: "/settings/claude" })).json()).toMatchObject({ limitPolicy: "wait", allowOverage: true });
    });

    it.each([
      [{ limitPolicy: "sometimes" }],
      [{ warnAt: 1.5 }],
      [{ warnAt: "0.8" }],
      [{ allowOverage: "yes" }],
      [{ preferred: "work" }],
      [{ limitPolcy: "wait" }], // typo'd key must not be silently ignored
    ])("PUT rejects %j with 400 and changes nothing", async (bad) => {
      expect((await putSettings(bad)).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/settings/claude" })).json()).toMatchObject({ limitPolicy: "failover-then-wait" });
    });

    it("a changed setting applies to the very next launch decision (no restart)", async () => {
      fake.work = ok(1, 0.1, R5);
      fake.personal = ok(1, 0.1, R5);
      Object.assign(fake.work, out());
      Object.assign(fake.personal, out());
      await refresh();
      const svc = new ClaudeService({ config, ledger, now: () => NOW });
      await putSettings({ limitPolicy: "failover" });
      expect(await svc.pickForLaunch()).toMatchObject({ kind: "blocked", message: expect.stringContaining('limitPolicy is "failover"') });
      await putSettings({ limitPolicy: "wait" });
      expect(await svc.pickForLaunch()).toMatchObject({ kind: "blocked", waitUntil: new Date(R5) });
      await putSettings({ limitPolicy: "off" });
      expect((await svc.pickForLaunch()).kind).toBe("account");
    });
  });

  describe("usage", () => {
    it("POST /usage/refresh probes each account and GET /usage returns snapshots without tokens", async () => {
      fake.work = ok(0.85);
      fake.personal = ok(0.2);
      const res = await refresh();
      expect(res.statusCode).toBe(200);
      const snap = (await app.inject({ method: "GET", url: "/usage" })).json() as { settings: unknown; accounts: { name: string; fingerprint: string; available: boolean; fiveHour: { utilization: number; resetsAt: string }; checkedAt: string }[] };
      expect(snap.accounts.map((a) => a.name)).toEqual(["personal", "work"]);
      const work = snap.accounts.find((a) => a.name === "work")!;
      expect(work).toMatchObject({ available: true, fiveHour: { utilization: 0.85, resetsAt: new Date(R5).toISOString() }, checkedAt: NOW.toISOString() });
      expect(work.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(snap.settings).toMatchObject({ limitPolicy: "failover-then-wait" });
      expect(JSON.stringify(snap)).not.toContain("SECRET");
      expect(JSON.stringify(snap)).not.toContain("sk-ant");
    });

    it("a failed probe records last_error and keeps the previous numbers", async () => {
      fake.work = ok(0.5);
      fake.personal = ok(0.5);
      await refresh();
      fake.work = "error";
      await refresh();
      const snap = (await app.inject({ method: "GET", url: "/usage" })).json() as { accounts: { name: string; lastError: string; fiveHour: { utilization: number } }[] };
      expect(snap.accounts.find((a) => a.name === "work")).toMatchObject({ lastError: "network down", fiveHour: { utilization: 0.5 } });
    });

    it("alerts once per window when 5h or 7d crosses warnAt, again for the next window", async () => {
      fake.work = ok(0.85);
      fake.personal = ok(0.1);
      await refresh();
      await refresh();
      const alerts = () => clickup.chatMessages.filter((m) => m.channelId === "alerts").map((m) => m.text);
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]).toContain('"work"');
      expect(alerts()[0]).toContain("85%");
      expect(alerts()[0]).not.toContain("sk-ant");
      fake.work = ok(0.9, 0.95); // 7d crosses too: its own window, its own alert
      await refresh();
      expect(alerts()).toHaveLength(2);
      expect(alerts()[1]).toContain("7d");
      fake.work = ok(0.9, 0.95, "2026-10-16T20:00:00Z"); // new 5h window
      await refresh();
      expect(alerts()).toHaveLength(3);
    });

    it("alert threshold follows the warnAt setting", async () => {
      await putSettings({ warnAt: 0.95 });
      fake.work = ok(0.85);
      fake.personal = ok(0.1);
      await refresh();
      expect(clickup.chatMessages).toHaveLength(0);
    });
  });

  describe("agent routes", () => {
    it("401 without a run token", async () => {
      expect((await app.inject({ method: "POST", url: "/agents/self/limit", payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/agents/self/usage" })).statusCode).toBe(401);
      const a = await agent("work");
      expect((await limit({ ...a.headers, authorization: "Bearer nope" })).statusCode).toBe(401);
    });

    it("400 on a malformed body", async () => {
      const a = await agent("work");
      expect((await limit(a.headers, { resetsAt: "tomorrow" })).statusCode).toBe(400);
      expect((await limit(a.headers, { window: "1h" })).statusCode).toBe(400);
    });

    it("GET /agents/self/usage shows headroom and the task's account", async () => {
      fake.work = ok(0.3);
      fake.personal = ok(0.6);
      await refresh();
      const a = await agent("work");
      const res = await app.inject({ method: "GET", url: "/agents/self/usage", headers: a.headers });
      const body = res.json() as { currentAccount: string; accounts: { name: string }[] };
      expect(body.currentAccount).toBe("work");
      expect(body.accounts).toHaveLength(2);
      expect(JSON.stringify(body)).not.toContain("sk-ant");
    });

    it("failover: marks the account out, returns the other token, records the new account on the task", async () => {
      fake.work = ok(0.2);
      fake.personal = ok(0.5);
      await refresh();
      const a = await agent("work");
      const res = await limit(a.headers, { account: "work", resetsAt: R5, window: "5h" });
      expect(res.json()).toEqual({ action: "failover", account: "personal", token: TOKENS.personal });
      expect((await ledger.getTask(a.taskId))?.claude_account).toBe("personal");
      const usage = (await ledger.listAccountUsage()).find((u) => u.name === "work")!;
      expect(usage.fiveHour).toMatchObject({ status: "rejected", utilization: 1, reset: new Date(R5) });
    });

    it("failover with no other account usable: exits under `failover`, waits under `failover-then-wait`", async () => {
      fake.work = ok(0.2);
      fake.personal = out("2026-10-16T18:00:00Z");
      await refresh();
      const a = await agent("work");
      await putSettings({ limitPolicy: "failover" });
      expect((await limit(a.headers, { resetsAt: R5 })).json()).toEqual({ action: "exit", reason: "no other Claude account has headroom" });
      await putSettings({ limitPolicy: "failover-then-wait" });
      // work frees up at R5 (15:00), personal not until 18:00: wait for work (the same account)
      expect((await limit(a.headers, { resetsAt: R5 })).json()).toEqual({ action: "wait", waitUntil: new Date(R5).toISOString() });
    });

    it("failover-then-wait: when another account frees up first, wait and then continue on it", async () => {
      fake.work = ok(0.2);
      fake.personal = out("2026-10-16T13:00:00Z");
      await refresh();
      const a = await agent("work");
      const res = await limit(a.headers, { resetsAt: R5 });
      expect(res.json()).toEqual({ action: "wait", waitUntil: "2026-10-16T13:00:00.000Z", account: "personal", token: TOKENS.personal });
      expect((await ledger.getTask(a.taskId))?.claude_account).toBe("personal");
    });

    it("wait: same account, until its reset; falls back to 30 min when no reset is known", async () => {
      await putSettings({ limitPolicy: "wait" });
      const a = await agent("work");
      expect((await limit(a.headers, { resetsAt: R5 })).json()).toEqual({ action: "wait", waitUntil: new Date(R5).toISOString() });
      const b = await agent("work");
      await pool.query("DELETE FROM claude_account_usage");
      expect((await limit(b.headers, {})).json()).toEqual({ action: "wait", waitUntil: new Date(NOW.getTime() + 30 * 60_000).toISOString() });
    });

    it("off: exit, and nothing is switched", async () => {
      await putSettings({ limitPolicy: "off" });
      const a = await agent("work");
      expect((await limit(a.headers, { resetsAt: R5 })).json()).toEqual({ action: "exit", reason: 'limitPolicy is "off"' });
      expect((await ledger.getTask(a.taskId))?.claude_account).toBe("work");
    });

    it("failover respects preferred order and allowOverage", async () => {
      const third = { ...config, claudeAccounts: [...config.claudeAccounts, { name: "spare", token: "sk-ant-SPARE", fingerprint: "abc" }] };
      const svc = new ClaudeService({ config: third, ledger, now: () => NOW });
      fake.work = ok(0.1);
      fake.personal = ok(0.5);
      await refresh();
      await ledger.saveAccountUsage({ name: "spare", fingerprint: "abc", fiveHour: { status: "rejected", utilization: 1, reset: new Date(R5) }, sevenDay: {}, overage: { status: "allowed", utilization: 0.1 }, representativeClaim: "overage" });
      const a = await agent("work");
      await putSettings({ preferred: ["spare", "personal"] });
      expect(await svc.onLimit(a.taskId, { resetsAt: new Date(R5) })).toMatchObject({ action: "failover", account: "personal" });
      await putSettings({ allowOverage: true });
      expect(await svc.onLimit(a.taskId, { account: "personal", resetsAt: new Date(R5) })).toMatchObject({ action: "failover", account: "spare" });
    });
  });

  describe("launch and finalize steps", () => {
    const started: RunSpec[] = [];
    const runtime: SandboxRuntime = {
      name: "k8s",
      start: async (spec) => (started.push(spec), { adapter: "k8s", externalId: spec.runId }),
      wait: async () => ({ code: 0 }),
      cancel: async () => {},
    };
    beforeAll(() => {
      setWorkflowDeps({ config, ledger, employees: new Map([["dev", employee]]), runtimes: { k8s: runtime }, slack: new NoopSlackClient(), clickup, secrets: new EnvSecretStore(), orchestrator: new DbosOrchestrator(ledger) });
    });
    const input = { employeeId: "dev", roleId: "assistant", prompt: "x", source: { channel: "http" as const } };

    it("picks the account with most headroom, records it on the task, and injects its token plus the account name", async () => {
      fake.work = ok(0.7);
      fake.personal = ok(0.2);
      await refresh();
      const a = await agent();
      const pick = await steps.pickClaudeAccount(a.taskId, input);
      expect(pick).toEqual({ account: "personal" });
      expect((await ledger.getTask(a.taskId))?.claude_account).toBe("personal");
      const spec = await steps.buildRunSpec(a.taskId, input);
      expect(spec.env.TASK_TIMEOUT_SEC).toBe("20");
      expect(JSON.stringify(pick)).not.toContain("sk-ant"); // DBOS stores step output
      await steps.launchSandbox(spec, "k8s", input, pick.account);
      expect(started.at(-1)!.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: TOKENS.personal, CLAUDE_ACCOUNT: "personal" });
    });

    it("blocked: `wait` yields a wait, `failover` a clear error", async () => {
      // steps use the real clock, so the resets must be far ahead of it
      fake.work = out("2099-01-01T00:00:00Z");
      fake.personal = out("2098-01-01T00:00:00Z");
      await refresh();
      await putSettings({ limitPolicy: "wait" });
      const a = await agent();
      const w = await steps.pickClaudeAccount(a.taskId, input);
      expect(w.account).toBeUndefined();
      expect(w.error).toBeUndefined();
      expect(w.waitMs).toBeGreaterThan(Date.parse("2097-12-31T00:00:00Z") - Date.now()); // until the earlier reset, personal's
      await putSettings({ limitPolicy: "failover" });
      expect(await steps.pickClaudeAccount(a.taskId, input)).toEqual({ error: 'every Claude account is at its limit and limitPolicy is "failover"' });
    });

    it("a role without the grant (or with its own claude-subscription login) is untouched", async () => {
      const plain = { ...employee, roles: [{ ...role, credentials: [] as string[] }] };
      setWorkflowDeps({ config, ledger, employees: new Map([["dev", plain]]), runtimes: { k8s: runtime }, slack: new NoopSlackClient(), clickup, secrets: new EnvSecretStore(), orchestrator: new DbosOrchestrator(ledger) });
      const a = await agent();
      expect(await steps.pickClaudeAccount(a.taskId, input)).toEqual({});
      setWorkflowDeps({ config, ledger, employees: new Map([["dev", employee]]), runtimes: { k8s: runtime }, slack: new NoopSlackClient(), clickup, secrets: new EnvSecretStore(), orchestrator: new DbosOrchestrator(ledger) });
    });

    it("a task that ends on the limit message marks its account out (passive record)", async () => {
      const a = await agent("work");
      const text = "You've hit your session limit · resets 11:30pm (UTC)";
      await steps.finalize(a.taskId, { code: 1 }, { runId: a.taskId, seq: 1, ts: "", type: "result", text, isError: true });
      const row = (await ledger.listAccountUsage()).find((u) => u.name === "work")!;
      expect(row.fiveHour.status).toBe("rejected");
      expect(row.fiveHour.reset!.getUTCHours()).toBe(23);
      expect(row.fiveHour.reset!.getUTCMinutes()).toBe(30);
    });

    it("failLaunch fails the task with the message", async () => {
      const a = await agent();
      await steps.failLaunch(a.taskId, input, "every Claude account is at its limit");
      const t = await ledger.getTask(a.taskId);
      expect(t?.status).toBe("failed");
      expect((t?.result as { text: string }).text).toBe("every Claude account is at its limit");
    });
  });
});
