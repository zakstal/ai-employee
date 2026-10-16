/**
 * Agent-to-agent messaging: POST/GET /agents/self/messages. Same trimmed boot as runtime.int.test.ts.
 * Needs Postgres from `make dev`.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Employee } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { Ledger } from "../db/ledger.js";
import { buildServer } from "./server.js";
import { NoopSlackClient } from "../slack/client.js";
import { NoopClickUpClient } from "../clickup/client.js";
import { resetTestDatabases, TEST_DB_URL, TEST_DBOS_URL } from "../test-support.js";
import { DbosOrchestrator } from "../orchestration/dbos-orchestrator.js";

const role = {
  id: "assistant", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
  maxTurns: 5, runtime: "k8s" as const, cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], repos: [],
  capabilities: [], canSchedule: [], canSpawn: [],
};
const mk = (id: string): Employee => ({ id, name: id, defaultRole: "assistant", workstreams: {}, monitors: {}, roles: [role] });

describe("agent messages: /agents/self/messages", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  let app: ReturnType<typeof buildServer>;

  async function agent(employeeId: string, name: string) {
    const taskId = `http:${employeeId}:${name}`;
    await ledger.createTask(taskId, { employeeId, roleId: "assistant", prompt: "noop", source: { channel: "http" } });
    return { taskId, headers: { authorization: `Bearer ${await ledger.issueRunToken(taskId, 600)}`, "x-task-id": taskId } };
  }
  const send = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: "/agents/self/messages", headers, payload: payload as object });
  const read = (headers: Record<string, string>, qs: string) => app.inject({ method: "GET", url: `/agents/self/messages?${qs}`, headers });
  type Msgs = { messages: { id: number; from: string; to: string | null; text: string; message: { role: string; contextId: string; parts: unknown[] } }[] };

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee("dev", "dev");
    await ledger.ensureEmployee("other", "other");
    const config = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL });
    app = buildServer({
      config,
      ledger,
      orchestrator: new DbosOrchestrator(ledger), // never invoked by these routes
      employees: new Map([mk("dev"), mk("other")].map((e) => [e.id, e])),
      slack: new NoopSlackClient(),
      clickup: new NoopClickUpClient(),
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("send returns 201 {id}; the stored body is an A2A Message", async () => {
    const a = await agent("dev", "a1");
    const b = await agent("dev", "b1");
    const res = await send(a.headers, { channel: "c.one", text: "claiming x.ts" });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: number };
    expect(typeof id).toBe("number");
    const { messages } = (await read(b.headers, "channel=c.one")).json() as Msgs;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id, from: a.taskId, to: null, text: "claiming x.ts" });
    expect(messages[0]!.message).toMatchObject({ role: "agent", contextId: "c.one", parts: [{ kind: "text", text: "claiming x.ts" }] });
  });

  it("read filters by channel, addressee, own messages and since", async () => {
    const a = await agent("dev", "a2");
    const b = await agent("dev", "b2");
    const c = await agent("dev", "c2");
    const m1 = ((await send(a.headers, { channel: "f.one", text: "all" })).json() as { id: number }).id;
    await send(a.headers, { channel: "f.two", text: "other channel" });
    const m3 = ((await send(a.headers, { channel: "f.one", text: "just b", to: b.taskId })).json() as { id: number }).id;
    await send(b.headers, { channel: "f.one", text: "from b" });

    const forB = ((await read(b.headers, "channel=f.one")).json() as Msgs).messages;
    expect(forB.map((m) => m.text)).toEqual(["all", "just b"]); // own "from b" and other channel excluded
    const forC = ((await read(c.headers, "channel=f.one")).json() as Msgs).messages;
    expect(forC.map((m) => m.text)).toEqual(["all", "from b"]); // "just b" is not addressed to c
    const afterM1 = ((await read(b.headers, `channel=f.one&since=${m1}`)).json() as Msgs).messages;
    expect(afterM1.map((m) => m.id)).toEqual([m3]);
  });

  it("is scoped to the employee: other employees' agents see nothing and cannot be addressed", async () => {
    const a = await agent("dev", "a3");
    const o = await agent("other", "o3");
    await send(a.headers, { channel: "iso.one", text: "private" });
    expect(((await read(o.headers, "channel=iso.one")).json() as Msgs).messages).toEqual([]);
    expect((await send(a.headers, { channel: "iso.one", text: "hi", to: o.taskId })).statusCode).toBe(404);
  });

  it("401 without a valid run token", async () => {
    const bad = { authorization: "Bearer nope", "x-task-id": "nope" };
    expect((await send(bad, { channel: "c", text: "x" })).statusCode).toBe(401);
    expect((await read(bad, "channel=c")).statusCode).toBe(401);
  });

  it("400 on bad channel, empty or oversized text, bad wait", async () => {
    const a = await agent("dev", "a4");
    for (const channel of ["", "Upper", "has space", "x".repeat(101)]) expect((await send(a.headers, { channel, text: "x" })).statusCode).toBe(400);
    expect((await send(a.headers, { channel: "ok", text: "" })).statusCode).toBe(400);
    expect((await send(a.headers, { channel: "ok", text: "x".repeat(8001) })).statusCode).toBe(400);
    expect((await send(a.headers, { channel: "ok", text: "x".repeat(8000) })).statusCode).toBe(201);
    expect((await read(a.headers, "channel=ok&wait=26")).statusCode).toBe(400);
    expect((await read(a.headers, "wait=0")).statusCode).toBe(400);
  });

  it("long-poll returns as soon as a message arrives, and empty after wait when none do", async () => {
    const a = await agent("dev", "a5");
    const b = await agent("dev", "b5");
    const started = Date.now();
    const pending = read(b.headers, "channel=lp.one&wait=10");
    setTimeout(() => void send(a.headers, { channel: "lp.one", text: "ping" }), 700);
    const res = await pending;
    expect((res.json() as Msgs).messages.map((m) => m.text)).toEqual(["ping"]);
    expect(Date.now() - started).toBeLessThan(5000);

    const t0 = Date.now();
    const empty = await read(b.headers, "channel=lp.quiet&wait=1");
    expect((empty.json() as Msgs).messages).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  }, 20_000);
});
