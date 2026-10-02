/**
 * GET /runtime and GET /status. Same boot pattern as workflow.int.test.ts, trimmed down: these
 * routes never touch the orchestrator or DBOS, so no DBOS.launch() is needed here.
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

const employee: Employee = {
  id: "dev",
  name: "Dev Bot",
  defaultRole: "assistant",
  workstreams: {},
  monitors: {},
  roles: [
    {
      id: "assistant", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
      maxTurns: 5, runtime: "k8s", cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], repos: [],
      capabilities: [], canSchedule: [], canSpawn: [],
    },
  ],
};

describe("live status: GET /runtime, GET /status", () => {
  let pool: pg.Pool;
  let ledger: Ledger;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee(employee.id, employee.name);
    // WARM_RUNNER_URL default points nowhere reachable in this test env → warm.error is expected.
    const config = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL });
    app = buildServer({
      config,
      ledger,
      orchestrator: new DbosOrchestrator(ledger), // never invoked by these routes
      employees: new Map([[employee.id, employee]]),
      slack: new NoopSlackClient(),
      clickup: new NoopClickUpClient(),
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("GET /runtime reports a warm error when the runner is unreachable and lists an active task", async () => {
    await ledger.createTask("http:dev:active-1", { employeeId: "dev", roleId: "assistant", prompt: "do the thing", source: { channel: "http" } });

    const res = await app.inject({ method: "GET", url: "/runtime" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      warm: { error?: string };
      active: { id: string; role: string; status: string; prompt: string }[];
      recent: { id: string; role: string; status: string }[];
    };

    expect(typeof body.warm.error).toBe("string");
    const active = body.active.find((t) => t.id === "http:dev:active-1");
    expect(active).toBeDefined();
    expect(active!.role).toBe("assistant");
    expect(active!.status).toBe("queued");
    expect(active!.prompt).toBe("do the thing");

    const recent = body.recent.find((t) => t.id === "http:dev:active-1");
    expect(recent).toBeDefined();
  }, 15_000);

  it("GET /status returns a self-contained HTML page", async () => {
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Slots");
  });
});
