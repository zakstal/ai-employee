/**
 * Operating the employee from chat: GET /agents/self/status, the `operate` routes (/operator/*), POST /agents/self/message-owner,
 * replyTo on POST /tasks and schedules, and /tasks/recent without a capability. Same trimmed boot as messages.int.test.ts, with a
 * recording orchestrator. Needs Postgres from `make dev`.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Employee, Orchestrator, Role, TaskInput } from "@ai-employee/core";
import { loadConfig, type Config } from "../config.js";
import { Ledger } from "../db/ledger.js";
import { buildServer } from "./server.js";
import { NoopSlackClient } from "../slack/client.js";
import { NoopClickUpClient } from "../clickup/client.js";
import { NoopTelegramClient } from "../telegram/client.js";
import { resetTestDatabases, TEST_DB_URL, TEST_DBOS_URL } from "../test-support.js";

const base: Role = {
  id: "assistant", description: "", systemPrompt: "x", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
  maxTurns: 5, runtime: "k8s", cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], repos: [],
  capabilities: [], canSchedule: ["assistant", "operator"], canSpawn: [],
};
const roles: Role[] = [
  base,
  { ...base, id: "operator", capabilities: ["operate", "schedules"] },
  { ...base, id: "worker" },
];
const mk = (id: string): Employee => ({ id, name: id, defaultRole: "assistant", workstreams: {}, monitors: {}, roles });

const env = { DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL };
const TG = { TELEGRAM_BOT_TOKEN: "fake-telegram-token", TELEGRAM_WEBHOOK_SECRET: "s", TELEGRAM_ALLOWED_CHAT_IDS: "7001,7002" };

describe("operator routes", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  let n = 0;
  const started: { id: string; input: TaskInput }[] = [];
  const cancelled: string[] = [];
  const orchestrator: Orchestrator = {
    async startTask(id, input) {
      const created = await ledger.createTask(id, input);
      if (created) started.push({ id, input });
      return { started: created, status: "queued" };
    },
    async cancel(id) {
      cancelled.push(id);
    },
    async signal() {},
    async status() {
      return "queued";
    },
    async schedule() {},
  };

  const boot = (over: Record<string, string> = {}, tg = new NoopTelegramClient(), clickup = new NoopClickUpClient()) => {
    const config: Config = loadConfig({ ...env, ...over });
    const app = buildServer({ config, ledger, orchestrator, employees: new Map([mk("dev"), mk("other")].map((e) => [e.id, e])), slack: new NoopSlackClient(), clickup, telegram: tg });
    return { app, tg, clickup };
  };

  /** A task of `role` + its run token headers. */
  async function agent(role: string, o: { employee?: string; source?: TaskInput["source"]; parent?: string; status?: "running" } = {}) {
    const id = `http:${o.employee ?? "dev"}:t${++n}`;
    await ledger.createTask(id, { employeeId: o.employee ?? "dev", roleId: role, prompt: `prompt of ${id}`, source: o.source ?? { channel: "http", ...(o.parent ? { parentTaskId: o.parent } : {}) } });
    if (o.status) await ledger.setStatus(id, o.status);
    return { id, headers: { authorization: `Bearer ${await ledger.issueRunToken(id, 600)}`, "x-task-id": id } };
  }

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee("dev", "dev");
    await ledger.ensureEmployee("other", "other");
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
  });

  describe("GET /agents/self/status", () => {
    it("401s without a run token", async () => {
      const { app } = boot();
      expect((await app.inject({ method: "GET", url: "/agents/self/status" })).statusCode).toBe(401);
      await app.close();
    });

    it("lists active tasks of every source with lineage, account and latest progress; finished tasks; and Claude usage — for a role with no capabilities", async () => {
      const { app } = boot();
      const me = await agent("worker", { status: "running" });
      const chat = await agent("assistant", { source: { channel: "telegram", threadRef: "7001" }, status: "running" });
      const child = await agent("worker", { source: { channel: "child", parentTaskId: chat.id, threadRef: "7001" }, status: "running" });
      await ledger.setTaskClaudeAccount(chat.id, "work");
      await ledger.appendEvent({ runId: chat.id, seq: 1, ts: "t", type: "assistant_text", text: "first thought" });
      await ledger.appendEvent({ runId: chat.id, seq: 2, ts: "t", type: "tool_use", tool: "Read", input: {} });
      await ledger.appendEvent({ runId: chat.id, seq: 3, ts: "t", type: "assistant_text", text: "  reading\nthe   migration  " });
      const asker = await agent("worker", { source: { channel: "slack", threadRef: "C1:1" } });
      await ledger.setQuestion(asker.id, "which branch?");
      await ledger.setStatus(asker.id, "awaiting_input");
      const sched = await agent("worker", { source: { channel: "cron" } });
      await ledger.setStatus(sched.id, "queued");
      const done = await agent("worker");
      await ledger.appendEvent({ runId: done.id, seq: 1, ts: "t", type: "result", text: "all good\nsecond line", isError: false, costUsd: 0.1234 });
      await ledger.setStatus(done.id, "done", { result: { text: "all good\nsecond line", costUsd: 0.1234 } });
      const other = await agent("worker", { employee: "other", status: "running" });

      const res = await app.inject({ method: "GET", url: "/agents/self/status", headers: me.headers });
      expect(res.statusCode).toBe(200);
      const b = res.json() as { employee: string; currentTask: string; active: Record<string, unknown>[]; finished: Record<string, unknown>[]; claude: { currentAccount: string | null; settings: { limitPolicy: string }; accounts: unknown[] } };
      expect(b.employee).toBe("dev");
      expect(b.currentTask).toBe(me.id);
      const ids = b.active.map((t) => t.id);
      expect(ids).toEqual(expect.arrayContaining([me.id, chat.id, child.id, asker.id, sched.id]));
      expect(ids).not.toContain(other.id); // another employee's work is not visible
      expect(ids).not.toContain(done.id);
      const byId = (id: string) => b.active.find((t) => t.id === id)!;
      expect(byId(chat.id)).toMatchObject({ role: "assistant", channel: "telegram", parent: null, root: chat.id, account: "work", status: "running", progress: "reading the migration", costUsd: null });
      expect(byId(child.id)).toMatchObject({ channel: "child", parent: chat.id, root: chat.id });
      expect(byId(asker.id)).toMatchObject({ status: "awaiting_input", question: "which branch?" });
      expect(byId(sched.id)).toMatchObject({ channel: "cron", status: "queued", progress: null });
      expect(typeof byId(chat.id).ageSec).toBe("number");
      expect(b.finished.find((t) => t.id === done.id)).toMatchObject({ status: "done", role: "worker", costUsd: 0.1234, result: "all good second line" });
      expect(b.claude.settings.limitPolicy).toBe("failover-then-wait");
      expect(b.claude.accounts).toEqual([]);
      await app.close();
    });

    it("only reports tasks finished in the last 24 hours", async () => {
      const { app } = boot();
      const me = await agent("worker");
      const old = await agent("worker");
      await ledger.setStatus(old.id, "done", { result: { text: "ancient" } });
      await pool.query("UPDATE tasks SET updated_at = now() - interval '30 hours' WHERE id = $1", [old.id]);
      const b = (await app.inject({ method: "GET", url: "/agents/self/status", headers: me.headers })).json() as { finished: { id: string }[] };
      expect(b.finished.map((t) => t.id)).not.toContain(old.id);
      await app.close();
    });
  });

  describe("list_tasks: GET /tasks/recent", () => {
    it("needs no capability any more, and still scopes to the employee", async () => {
      const { app } = boot();
      const me = await agent("worker");
      const other = await agent("worker", { employee: "other" });
      const res = await app.inject({ method: "GET", url: "/tasks/recent", headers: me.headers });
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as { tasks: { id: string }[] }).tasks.map((t) => t.id);
      expect(ids).toContain(me.id);
      expect(ids).not.toContain(other.id);
      await app.close();
    });
  });

  describe("operate capability", () => {
    const routes: [string, string, unknown?][] = [
      ["POST", "/operator/tasks", { role: "worker", prompt: "x" }],
      ["POST", "/operator/tasks/http:dev:nope/cancel", {}],
      ["GET", "/operator/tasks/http:dev:nope/events"],
      ["GET", "/operator/settings/claude"],
      ["PUT", "/operator/settings/claude", { warnAt: 0.5 }],
    ];

    it("401s without a run token and 403s a role without `operate`, naming the capability", async () => {
      const { app } = boot();
      const plain = await agent("worker");
      for (const [method, url, payload] of routes) {
        expect((await app.inject({ method: method as "GET", url, ...(payload ? { payload: payload as object } : {}) })).statusCode, `${method} ${url} anon`).toBe(401);
        const res = await app.inject({ method: method as "GET", url, headers: plain.headers, ...(payload ? { payload: payload as object } : {}) });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect((res.json() as { error: string }).error).toBe('role worker lacks the "operate" capability');
      }
      expect(started).toHaveLength(0);
      await app.close();
    });

    it("start_task: starts a top-level http task of the named role, dedupes by task_key, rejects unknown roles and bad bodies", async () => {
      const { app } = boot();
      const op = await agent("operator");
      const post = (payload: unknown) => app.inject({ method: "POST", url: "/operator/tasks", headers: op.headers, payload: payload as object });
      const res = await post({ role: "worker", prompt: "do the thing", taskKey: "k1" });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ taskId: "http:dev:k1", started: true });
      expect(started.find((s) => s.id === "http:dev:k1")!.input).toEqual({ employeeId: "dev", roleId: "worker", prompt: "do the thing", source: { channel: "http" } });
      const again = await post({ role: "worker", prompt: "do the thing", taskKey: "k1" });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ started: false });
      expect((await post({ role: "nope", prompt: "x" })).statusCode).toBe(400);
      expect((await post({ role: "worker" })).statusCode).toBe(400);
      expect((await post({ role: "worker", prompt: "x", replyTo: { channel: "email" } })).statusCode).toBe(400);
      await app.close();
    });

    it("start_task with replyTo telegram: delivers to the owner chat by default, an explicit allowed chat, refuses others and a disabled Telegram", async () => {
      const { app } = boot(TG);
      const op = await agent("operator");
      const post = (payload: unknown) => app.inject({ method: "POST", url: "/operator/tasks", headers: op.headers, payload: payload as object });
      expect((await post({ role: "worker", prompt: "p", taskKey: "r1", replyTo: { channel: "telegram" } })).statusCode).toBe(202);
      expect(started.find((s) => s.id === "http:dev:r1")!.input.source).toEqual({ channel: "telegram", threadRef: "7001", quiet: true });
      expect((await post({ role: "worker", prompt: "p", taskKey: "r2", replyTo: { channel: "telegram", chat: "7002" } })).statusCode).toBe(202);
      expect(started.find((s) => s.id === "http:dev:r2")!.input.source).toMatchObject({ threadRef: "7002" });
      const bad = await post({ role: "worker", prompt: "p", taskKey: "r3", replyTo: { channel: "telegram", chat: "9999" } });
      expect(bad.statusCode).toBe(400);
      expect(await ledger.getTask("http:dev:r3")).toBeUndefined();
      await app.close();

      const off = boot();
      const op2 = await agent("operator");
      const res = await off.app.inject({ method: "POST", url: "/operator/tasks", headers: op2.headers, payload: { role: "worker", prompt: "p", replyTo: { channel: "telegram" } } });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/not enabled/);
      await off.app.close();
    });

    it("OWNER_TELEGRAM_CHAT_ID wins over the first allowed chat", async () => {
      const { app } = boot({ ...TG, OWNER_TELEGRAM_CHAT_ID: "7002" });
      const op = await agent("operator");
      await app.inject({ method: "POST", url: "/operator/tasks", headers: op.headers, payload: { role: "worker", prompt: "p", taskKey: "o1", replyTo: { channel: "telegram" } } });
      expect(started.find((s) => s.id === "http:dev:o1")!.input.source).toMatchObject({ threadRef: "7002" });
      await app.close();
    });

    it("cancel_task: cancels any task of the employee (not only children), no-ops on finished ones, 404s other employees, refuses self", async () => {
      const { app } = boot();
      const op = await agent("operator");
      const victim = await agent("worker", { source: { channel: "slack", threadRef: "C:1" }, status: "running" });
      const cancel = (id: string) => app.inject({ method: "POST", url: `/operator/tasks/${encodeURIComponent(id)}/cancel`, headers: op.headers, payload: {} });
      const res = await cancel(victim.id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ taskId: victim.id, status: "cancelling" });
      expect(cancelled).toContain(victim.id);

      const finished = await agent("worker");
      await ledger.setStatus(finished.id, "done");
      const before = cancelled.length;
      expect((await cancel(finished.id)).json()).toEqual({ taskId: finished.id, status: "done" });
      expect(cancelled).toHaveLength(before);

      const foreign = await agent("worker", { employee: "other", status: "running" });
      expect((await cancel(foreign.id)).statusCode).toBe(404);
      expect(cancelled).not.toContain(foreign.id);
      expect((await cancel("http:dev:missing")).statusCode).toBe(404);
      expect((await cancel(op.id)).statusCode).toBe(409);
      await app.close();
    });

    it("task_events: events of any task of the employee, since/limit honoured, other employees 404, bad query 400", async () => {
      const { app } = boot();
      const op = await agent("operator");
      const t = await agent("worker", { source: { channel: "clickup", threadRef: "abc" }, status: "running" });
      for (let i = 1; i <= 5; i++) await ledger.appendEvent({ runId: t.id, seq: i, ts: "t", type: "assistant_text", text: `e${i}` });
      const get = (id: string, qs = "") => app.inject({ method: "GET", url: `/operator/tasks/${encodeURIComponent(id)}/events${qs}`, headers: op.headers });
      const all = (await get(t.id)).json() as { status: string; role: string; events: { seq: number }[] };
      expect(all).toMatchObject({ taskId: t.id, status: "running", role: "worker" });
      expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(((await get(t.id, "?since=3")).json() as typeof all).events.map((e) => e.seq)).toEqual([4, 5]);
      expect(((await get(t.id, "?limit=2")).json() as typeof all).events.map((e) => e.seq)).toEqual([4, 5]);
      expect((await get(t.id, "?limit=9999")).statusCode).toBe(400);
      const foreign = await agent("worker", { employee: "other" });
      expect((await get(foreign.id)).statusCode).toBe(404);
      await app.close();
    });

    it("claude_settings: get returns the settings; set validates like PUT /settings/claude, merges, and persists", async () => {
      const { app } = boot();
      const op = await agent("operator");
      const get = async () => (await app.inject({ method: "GET", url: "/operator/settings/claude", headers: op.headers })).json();
      expect(await get()).toEqual({ limitPolicy: "failover-then-wait", allowOverage: false, warnAt: 0.8, preferred: [] });
      const put = (payload: unknown) => app.inject({ method: "PUT", url: "/operator/settings/claude", headers: op.headers, payload: payload as object });
      const ok = await put({ allowOverage: true, preferred: ["Work", "personal"], warnAt: 0.7 });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ limitPolicy: "failover-then-wait", allowOverage: true, warnAt: 0.7, preferred: ["work", "personal"] });
      expect(await get()).toMatchObject({ allowOverage: true, warnAt: 0.7 });
      expect((await put({ limitPolicy: "yolo" })).statusCode).toBe(400);
      expect((await put({ warnAt: 2 })).statusCode).toBe(400);
      expect((await put({ typo: 1 })).statusCode).toBe(400);
      expect((await put({})).statusCode).toBe(400);
      expect(await get()).toMatchObject({ allowOverage: true, warnAt: 0.7 }); // rejected patches changed nothing
      await app.close();
    });
  });

  describe("POST /agents/self/message-owner", () => {
    const send = (app: ReturnType<typeof boot>["app"], headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: "/agents/self/message-owner", headers, payload: payload as object });

    it("sends to the owner's Telegram chat for any role; 401 without a token; 400 on empty text", async () => {
      const { app, tg } = boot(TG);
      const me = await agent("worker");
      expect((await app.inject({ method: "POST", url: "/agents/self/message-owner", payload: { text: "hi" } })).statusCode).toBe(401);
      expect((await send(app, me.headers, { text: "" })).statusCode).toBe(400);
      const res = await send(app, me.headers, { text: "build is green" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, channel: "telegram", parts: 1 });
      expect(tg.messages).toEqual([{ id: expect.any(String), chatId: "7001", text: "build is green" }]);
      await app.close();
    });

    it("uses OWNER_TELEGRAM_CHAT_ID when set, and splits text over 4096 chars", async () => {
      const { app, tg } = boot({ ...TG, OWNER_TELEGRAM_CHAT_ID: "7002" });
      const me = await agent("worker");
      const res = await send(app, me.headers, { text: "z".repeat(9000) });
      expect(res.json()).toMatchObject({ channel: "telegram", parts: 3 });
      expect(tg.messages.map((m) => m.chatId)).toEqual(["7002", "7002", "7002"]);
      expect(tg.messages.every((m) => m.text.length <= 4096)).toBe(true);
      expect(tg.messages.map((m) => m.text).join("")).toBe("z".repeat(9000));
      await app.close();
    });

    it("falls back to the ClickUp alert channel when Telegram is off, and 409s when there is no owner channel at all", async () => {
      const { app, clickup } = boot({ ALERT_CHANNEL_ID: "alerts", CLICKUP_TEAM_ID: "team1" });
      const me = await agent("worker");
      const res = await send(app, me.headers, { text: "need a decision" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ channel: "clickup" });
      expect(clickup.chatMessages).toHaveLength(1);
      expect(clickup.chatMessages[0]).toMatchObject({ channelId: "alerts" });
      expect(clickup.chatMessages[0]!.text).toContain("need a decision");
      await app.close();

      const none = boot();
      const me2 = await agent("worker");
      const r2 = await send(none.app, me2.headers, { text: "anyone?" });
      expect(r2.statusCode).toBe(409);
      expect((r2.json() as { error: string }).error).toMatch(/no owner channel/);
      await none.app.close();
    });

    it("Telegram wins over ClickUp when both are configured", async () => {
      const { app, tg, clickup } = boot({ ...TG, ALERT_CHANNEL_ID: "alerts", CLICKUP_TEAM_ID: "t" });
      const me = await agent("worker");
      expect((await send(app, me.headers, { text: "x" })).json()).toMatchObject({ channel: "telegram" });
      expect(tg.messages).toHaveLength(1);
      expect(clickup.chatMessages).toHaveLength(0);
      await app.close();
    });

    it("rate-limits to 20 per hour per task (other tasks unaffected); a failed send does not count", async () => {
      const { app, tg } = boot(TG);
      const me = await agent("worker");
      for (let i = 0; i < 20; i++) expect((await send(app, me.headers, { text: `m${i}` })).statusCode).toBe(201);
      const over = await send(app, me.headers, { text: "one too many" });
      expect(over.statusCode).toBe(429);
      expect(tg.messages).toHaveLength(20);
      const other = await agent("worker");
      expect((await send(app, other.headers, { text: "mine" })).statusCode).toBe(201);

      const failing = new NoopTelegramClient();
      failing.sendMessage = async () => {
        throw new Error("telegram sendMessage → 500");
      };
      const f = boot(TG, failing);
      const me3 = await agent("worker");
      const r = await send(f.app, me3.headers, { text: "x" });
      expect(r.statusCode).toBe(502);
      for (let i = 0; i < 20; i++) await send(f.app, me3.headers, { text: "x" });
      expect((await send(f.app, me3.headers, { text: "x" })).statusCode).toBe(502); // still failing, never 429: failures are not counted
      await app.close();
      await f.app.close();
    });
  });

  describe("replyTo on POST /tasks and schedule deliverTo", () => {
    it("POST /tasks replyTo telegram: source is the owner chat, quiet; absent replyTo keeps the http source", async () => {
      const { app } = boot(TG);
      const a = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "p", taskKey: "p1", replyTo: { channel: "telegram" } } });
      expect(a.statusCode).toBe(202);
      expect(started.find((s) => s.id === "http:dev:p1")!.input.source).toEqual({ channel: "telegram", threadRef: "7001", quiet: true });
      const b = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "p", taskKey: "p2", replyTo: { channel: "telegram", chat: "7002" }, managedBy: "manager" } });
      expect(started.find((s) => s.id === "http:dev:p2")!.input.source).toEqual({ channel: "telegram", threadRef: "7002", quiet: true, managedBy: "manager" });
      expect(b.statusCode).toBe(202);
      await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "p", taskKey: "p3" } });
      expect(started.find((s) => s.id === "http:dev:p3")!.input.source).toEqual({ channel: "http" });
      expect((await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "p", replyTo: { channel: "telegram", chat: "1" } } })).statusCode).toBe(400);
      await app.close();
      const off = boot();
      expect((await off.app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "p", replyTo: { channel: "telegram" } } })).statusCode).toBe(400);
      await off.app.close();
    });

    it("schedules accept deliverTo telegram (chat defaults to the owner's), validated like replyTo", async () => {
      const { app } = boot(TG);
      const op = await agent("operator");
      const create = (name: string, deliverTo: unknown) => app.inject({ method: "POST", url: "/schedules", headers: op.headers, payload: { name, cron: "0 9 * * *", prompt: "digest", deliverTo } as object });
      const a = await create("tg-default", { channel: "telegram" });
      expect(a.statusCode).toBe(201);
      expect((a.json() as { schedule: { deliver_to: unknown } }).schedule.deliver_to).toEqual({ channel: "telegram", threadRef: "7001" });
      const b = await create("tg-explicit", { channel: "telegram", threadRef: "7002" });
      expect((b.json() as { schedule: { deliver_to: unknown } }).schedule.deliver_to).toEqual({ channel: "telegram", threadRef: "7002" });
      expect((await create("tg-stranger", { channel: "telegram", threadRef: "5" })).statusCode).toBe(400);
      expect((await create("bad-channel", { channel: "email", threadRef: "x" })).statusCode).toBe(400);
      // a schedule made from a Telegram conversation defaults to that chat
      const fromChat = await agent("operator", { source: { channel: "telegram", threadRef: "7002" } });
      const c = await app.inject({ method: "POST", url: "/schedules", headers: fromChat.headers, payload: { name: "from-chat", cron: "0 9 * * *", prompt: "x" } });
      expect(c.statusCode).toBe(201);
      expect((c.json() as { schedule: { deliver_to: unknown } }).schedule.deliver_to).toEqual({ channel: "telegram", threadRef: "7002" });
      await app.close();
      const off = boot();
      const op2 = await agent("operator");
      expect((await off.app.inject({ method: "POST", url: "/schedules", headers: op2.headers, payload: { name: "tg-off", cron: "0 9 * * *", prompt: "x", deliverTo: { channel: "telegram" } } })).statusCode).toBe(400);
      await off.app.close();
    });
  });
});
