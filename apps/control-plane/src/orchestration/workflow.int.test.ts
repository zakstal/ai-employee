/**
 * End-to-end on a laptop: HTTP trigger → DBOS workflow → LocalProcessRuntime
 * "sandbox" (a curl one-liner standing in for the runner) → event sink →
 * ledger → Slack reply. Needs Postgres from `make dev`.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import * as monitors from "../monitors/tick.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessRuntime } from "@ai-employee/adapters";
import type { Employee, RunSpec } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { Ledger } from "../db/ledger.js";
import { buildServer } from "../http/server.js";
import { NoopSlackClient } from "../slack/client.js";
import { NoopClickUpClient } from "../clickup/client.js";
import { fireDueSchedules } from "../schedules/tick.js";
import { resetTestDatabases, TEST_DB_URL, TEST_DBOS_URL } from "../test-support.js";
import { EnvSecretStore } from "../credentials/index.js";
import { deps, setWorkflowDeps } from "./deps.js";
import { buildRunSpec } from "./steps.js";
import { DbosOrchestrator } from "./dbos-orchestrator.js";

const employee: Employee = {
  id: "dev",
  name: "Dev Bot",
  defaultRole: "assistant",
  credentials: { vault: { kind: "secret", env: { SENTINEL_ENV: { secret: "sentinel" } } } },
  workstreams: { sdlc: { entryRole: "assistant", description: "test workstream" } },
  monitors: {
    "support-watch": { collector: "clickup-channels", everyMin: 5, role: "ops", description: "test watcher", config: { channels: [{ id: "sup-1", name: "us-support" }] } },
  },
  roles: [
    {
      id: "assistant", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
      maxTurns: 5, runtime: "k8s", cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], repos: [],
      capabilities: ["schedules", "agents", "monitors"], canSchedule: ["ops"], canSpawn: ["ops", "assistant"],
    },
    {
      id: "vault", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
      maxTurns: 5, runtime: "k8s", cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], grants: ["vault"], repos: [],
      capabilities: [], canSchedule: [], canSpawn: [],
    },
    {
      id: "ops", description: "", systemPrompt: "be brief", allowedTools: ["Read"], disallowedTools: [], mcpServers: {},
      maxTurns: 5, runtime: "k8s", cpu: 1, memoryMb: 256, timeoutSec: 20, credentials: [], repos: [],
      capabilities: [], canSchedule: [], canSpawn: [],
    },
  ],
};

/** Stand-in runner: posts one result event then exits 0 (or exits non-zero without a result). */
function fakeRunnerCommand(spec: RunSpec): string[] {
  const prompt = spec.env.TASK_PROMPT ?? "";
  const fail = prompt.includes("FAIL");
  // Session trace only for chat-conversation runs (history paste or resumed), so other tests keep exact echoes.
  const chatRun = Boolean(spec.env.RESUME_SESSION_ID) || (Boolean(spec.env.WORKSPACE_KEY) && prompt.includes("Conversation so far"));
  const cred = spec.env.SENTINEL_ENV ? ` [cred=${spec.env.SENTINEL_ENV}]` : "";
  const trace = chatRun ? ` [resume=${spec.env.RESUME_SESSION_ID ?? "none"} ws=${spec.env.WORKSPACE_KEY ?? "none"}]` : "";
  const events = JSON.stringify({
    events: [
      { runId: spec.runId, seq: 1, ts: "2026-01-01T00:00:00Z", type: "started", harness: "fake", sessionId: `sess-${spec.runId}` },
      { runId: spec.runId, seq: 2, ts: "2026-01-01T00:00:01Z", type: "result", text: `echo: ${prompt}${trace}${cred}`, isError: false, numTurns: 1 },
    ],
  });
  const post = `curl -sf -X POST -H "authorization: Bearer $RUN_TOKEN" -H "content-type: application/json" --data '${events.replace(/'/g, "'\\''")}' "$EVENT_SINK_URL"`;
  return ["sh", "-c", fail ? "exit 7" : post];
}

describe("task workflow end-to-end (DBOS + local runtime)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildServer>;
  let slack: NoopSlackClient;
  let clickup: NoopClickUpClient;
  let ledger: Ledger;
  let baseUrl: string;

  beforeAll(async () => {
    await resetTestDatabases();
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new Ledger(pool);
    await ledger.ensureEmployee(employee.id, employee.name);
    slack = new NoopSlackClient();
    clickup = new NoopClickUpClient();
    const employees = new Map([[employee.id, employee]]);
    const config = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, SANDBOX_RUNTIME: "local", PUBLIC_BASE_URL: "http://127.0.0.1:1" });
    const runtimes = { local: new LocalProcessRuntime(fakeRunnerCommand) };

    const orchestrator = new DbosOrchestrator(ledger);
    app = buildServer({ config, ledger, orchestrator, employees, slack, clickup });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    // Steps read PUBLIC_BASE_URL from deps → point it at the ephemeral port.
    setWorkflowDeps({ config: { ...config, PUBLIC_BASE_URL: baseUrl }, ledger, employees, runtimes, slack, clickup, secrets: new EnvSecretStore(), orchestrator });

    DBOS.setConfig({ name: "ai-employee-test", systemDatabaseUrl: TEST_DBOS_URL });
    await DBOS.launch();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await DBOS.shutdown();
    await pool?.end();
  });

  async function waitFor(taskId: string, statuses: string[], ms = 20_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const t = await ledger.getTask(taskId);
      if (t && statuses.includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`task ${taskId} did not reach ${statuses.join("|")}: ${(await ledger.getTask(taskId))?.status}`);
  }

  it("runs a task to done and replies in the Slack thread", async () => {
    const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "hello world", taskKey: "t1" } });
    expect(res.statusCode).toBe(202);
    const { taskId } = res.json() as { taskId: string };

    const t = await waitFor(taskId, ["done", "failed"]);
    expect(t.status).toBe("done");
    expect((t.result as { text: string }).text).toBe("echo: hello world");
    const events = await ledger.listEvents(taskId);
    expect(events.map((e) => e.type)).toEqual(["started", "result"]);
  }, 30_000);

  it("credentials reach the sandbox but never the recorded step outputs", async () => {
    process.env.SECRET_SENTINEL = "SECRET-SENTINEL";
    const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", roleId: "vault", prompt: "creds", taskKey: "creds1" } });
    const { taskId } = res.json() as { taskId: string };
    const t = await waitFor(taskId, ["done", "failed"]);
    delete process.env.SECRET_SENTINEL;
    expect((t.result as { text: string }).text).toBe("echo: creds [cred=SECRET-SENTINEL]");
    const dbos = new pg.Pool({ connectionString: TEST_DBOS_URL });
    const { rows } = await dbos.query("SELECT function_name, output FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name IN ('buildRunSpec', 'launchSandbox')", [taskId]);
    await dbos.end();
    expect(rows.map((r) => r.function_name).sort()).toEqual(["buildRunSpec", "launchSandbox"]); // the fake runner echoes its env into the result, so only the launch steps are checked
    expect(JSON.stringify(rows)).not.toContain("SECRET-SENTINEL");
  }, 30_000);

  it("dedups the same task key", async () => {
    const a = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "once", taskKey: "dup" } });
    const b = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "twice", taskKey: "dup" } });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect((b.json() as { started: boolean }).started).toBe(false);
    const t = await waitFor((a.json() as { taskId: string }).taskId, ["done"]);
    expect(t.prompt).toBe("once");
  }, 30_000);

  it("marks failed when the sandbox exits non-zero without a result", async () => {
    const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", prompt: "please FAIL", taskKey: "t3" } });
    const t = await waitFor((res.json() as { taskId: string }).taskId, ["done", "failed"]);
    expect(t.status).toBe("failed");
    expect((t.result as { exit: { code: number } }).exit.code).toBe(7);
  }, 30_000);

  it("rejects event pushes with a bad run token", async () => {
    const res = await app.inject({ method: "POST", url: "/runs/nope/events", headers: { authorization: "Bearer x" }, payload: { events: [] } });
    expect(res.statusCode).toBe(401);
  });

  it("Slack: verifies signature, answers url_verification, starts a task per message, replies in thread", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "sekrit";
    const cfg = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, SLACK_SIGNING_SECRET: secret, SANDBOX_RUNTIME: "local" });
    const orchestrator = new DbosOrchestrator(ledger);
    const slackApp = buildServer({ config: cfg, ledger, orchestrator, employees: new Map([[employee.id, employee]]), slack, clickup });
    const signed = (body: object) => {
      const raw = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      return { payload: raw, headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex") } };
    };

    const bad = await slackApp.inject({ method: "POST", url: "/slack/events", payload: "{}", headers: { "content-type": "application/json", "x-slack-signature": "v0=00", "x-slack-request-timestamp": "1" } });
    expect(bad.statusCode).toBe(401);

    const chal = await slackApp.inject({ method: "POST", url: "/slack/events", ...signed({ type: "url_verification", challenge: "abc" }) });
    expect(chal.json()).toEqual({ challenge: "abc" });

    const ev = { type: "event_callback", team_id: "T1", event: { type: "app_mention", user: "U1", text: "<@UBOT> say hi", ts: "1700000000.000100", channel: "C1" } };
    const first = await slackApp.inject({ method: "POST", url: "/slack/events", ...signed(ev) });
    expect(first.statusCode).toBe(200);
    const taskId = "slack:T1:C1:1700000000.000100";
    const t = await waitFor(taskId, ["done"]);
    expect(t.prompt).toBe("say hi");
    expect(slack.sent).toContainEqual({ channel: "C1", thread_ts: "1700000000.000100", text: "echo: say hi" });

    // Slack retry of the same event → dedup, "already working" only if still active (it's done now, so silent)
    const again = await slackApp.inject({ method: "POST", url: "/slack/events", ...signed(ev) });
    expect(again.statusCode).toBe(200);
    expect((await ledger.listTasks("dev")).filter((x) => x.id === taskId)).toHaveLength(1);
    await slackApp.close();
  }, 30_000);

  it("ClickUp: verifies X-Signature, triggers on @mention comment, enriches prompt with task context, comments the result back", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "whsec";
    const cfg = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, CLICKUP_WEBHOOK_SECRET: secret, CLICKUP_BOT_USER_ID: "999", SANDBOX_RUNTIME: "local" });
    const cuApp = buildServer({ config: cfg, ledger, orchestrator: new DbosOrchestrator(ledger), employees: new Map([[employee.id, employee]]), slack, clickup });
    clickup.tasks.set("abc123", { id: "abc123", name: "Fix login bug", url: "https://app.clickup.com/t/abc123", description: "Users see a 500 on login." });
    const body = JSON.stringify({ event: "taskCommentPosted", task_id: "abc123", history_items: [{ comment: { id: "c9", text_content: "!dev what is the root cause?", user: { id: 1, username: "alice" } } }] });
    const headers = { "content-type": "application/json", "x-signature": createHmac("sha256", secret).update(body).digest("hex") };

    const bad = await cuApp.inject({ method: "POST", url: "/clickup/webhook", payload: body, headers: { ...headers, "x-signature": "00" } });
    expect(bad.statusCode).toBe(401);

    const res = await cuApp.inject({ method: "POST", url: "/clickup/webhook", payload: body, headers });
    expect(res.statusCode).toBe(200);
    const t = await waitFor("clickup:abc123:comment:c9", ["done"]);
    expect(t.prompt).toBe("what is the root cause?");
    // fake runner echoes TASK_PROMPT, which is the enriched prompt → proves task context reached the sandbox
    expect((t.result as { text: string }).text).toContain("ClickUp task abc123: Fix login bug");
    expect((t.result as { text: string }).text).toContain("Users see a 500 on login.");
    // one placeholder comment, edited in place into the answer
    expect(clickup.comments.filter((c) => c.taskId === "abc123")).toHaveLength(1);
    expect(clickup.comments[0]!.text.startsWith("\u{1F916} ")).toBe(true);
    expect(clickup.comments[0]!.text).not.toBe("\u{1F916} …");

    // redelivery → dedup
    const again = await cuApp.inject({ method: "POST", url: "/clickup/webhook", payload: body, headers });
    expect((again.json() as { started: boolean }).started).toBe(false);
    await cuApp.close();
  }, 30_000);

  it("ClickUp chat: shared-secret header, history in prompt, bot-marked reply, loop guard", async () => {
    const cfg = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, CLICKUP_CHAT_SECRET: "s3", CLICKUP_TEAM_ID: "1234567", SANDBOX_RUNTIME: "local" });
    const chatApp = buildServer({ config: cfg, ledger, orchestrator: new DbosOrchestrator(ledger), employees: new Map([[employee.id, employee]]), slack, clickup });
    clickup.history.set("ch1", [
      { id: "m2", text: "hi bot, remember 42", userId: "1" },
      { id: "m1", text: "\u{1F916} Hello! How can I help?", userId: "1" },
    ]);
    const payload = { id: "m3", channel_id: "ch1", content: "what number did I ask you to remember?", user_id: 1 };

    expect((await chatApp.inject({ method: "POST", url: "/clickup/chat", payload })).statusCode).toBe(401);
    // secret as a URL parameter with a trailing period (as ClickUp's UI produced it) is accepted
    expect((await chatApp.inject({ method: "POST", url: "/clickup/chat?X-Bot-Secret=s3.", payload: { id: "m0", channel_id: "ch0", content: "" } })).json()).toEqual({ ok: true, ignored: true });
    const res = await chatApp.inject({ method: "POST", url: "/clickup/chat", payload, headers: { "x-bot-secret": "s3" } });
    expect(res.statusCode).toBe(200);
    const t = await waitFor("clickup-chat:ch1:m3", ["done"]);
    const text = (t.result as { text: string }).text;
    expect(text).toContain("Conversation so far");
    expect(text).toContain("you: Hello! How can I help?");
    expect(text).toContain("user 1: hi bot, remember 42");
    expect(text).toContain("Latest message from the user:\nwhat number did I ask you to remember?");
    expect(clickup.reactions).toHaveLength(0);
    // placeholder posted immediately, then edited into the answer → still exactly one message
    expect(clickup.chatMessages).toHaveLength(1);
    expect(clickup.chatMessages[0]!.text.startsWith("\u{1F916} ")).toBe(true);
    expect(clickup.chatMessages[0]!.text).not.toBe("\u{1F916} …");

    // the bot's own reply arriving back via the automation must be ignored
    const echo = await chatApp.inject({ method: "POST", url: "/clickup/chat", payload: { id: "m4", channel_id: "ch1", content: clickup.chatMessages[0]!.text }, headers: { "x-bot-secret": "s3" } });
    expect((echo.json() as { ignored?: boolean }).ignored).toBe(true);

    // first message of a conversation: fresh session, stable per-conversation workspace, session id recorded
    expect(text).toContain("resume=none ws=conv-");
    const convId = t.conversation_id!;
    expect(await ledger.getConversationSession(convId)).toBe("sess-clickup-chat:ch1:m3");

    // next message in the same channel resumes that session and skips the transcript paste
    const res2 = await chatApp.inject({ method: "POST", url: "/clickup/chat", payload: { id: "m5", channel_id: "ch1", content: "and now?" }, headers: { "x-bot-secret": "s3" } });
    expect(res2.statusCode).toBe(200);
    const t2 = await waitFor("clickup-chat:ch1:m5", ["done"]);
    const text2 = (t2.result as { text: string }).text;
    expect(text2).toContain("resume=sess-clickup-chat:ch1:m3");
    expect(text2).toContain(`ws=conv-${convId}`);
    expect(text2).not.toContain("Conversation so far");
    expect(text2).toContain("echo: and now?");
    expect(await ledger.getConversationSession(convId)).toBe("sess-clickup-chat:ch1:m5");
    await chatApp.close();
  }, 45_000);

  describe("agent-creatable schedules", () => {
    /** Real task + a real run token (agent auth), scoped to whichever role the task carries. */
    async function taskAndToken(roleId?: string) {
      const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", roleId, prompt: "noop", taskKey: randomUUID() } });
      const { taskId } = res.json() as { taskId: string };
      const token = await ledger.issueRunToken(taskId, 600);
      return { taskId, headers: { authorization: `Bearer ${token}`, "x-task-id": taskId } };
    }

    it("creates a schedule for the calling role (201), with next_fire_at computed", async () => {
      const { headers } = await taskAndToken(); // defaultRole: assistant, has capability "schedules"
      const res = await app.inject({
        method: "POST", url: "/schedules", headers,
        payload: { name: "digest", cron: "*/15 * * * *", prompt: "send the digest", deliverTo: { channel: "clickup", threadRef: "abc123" } },
      });
      expect(res.statusCode).toBe(201);
      const { schedule } = res.json() as { schedule: { id: string; role_id: string; next_fire_at: string } };
      expect(schedule.id).toMatch(/^sch_/);
      expect(schedule.role_id).toBe("assistant");
      expect(new Date(schedule.next_fire_at).getTime()).toBeGreaterThan(Date.now());
    });

    it("a schedule without a timezone uses DEFAULT_TZ", async () => {
      const { headers } = await taskAndToken();
      const d = deps();
      const paris = buildServer({ config: { ...d.config, DEFAULT_TZ: "Europe/Paris" }, ledger, orchestrator: d.orchestrator, employees: d.employees, slack, clickup });
      const res = await paris.inject({ method: "POST", url: "/schedules", headers, payload: { name: "tz-default", cron: "0 * * * *", prompt: "x", deliverTo: { channel: "clickup", threadRef: "abc123" } } });
      await paris.close();
      expect(res.statusCode).toBe(201);
      expect((res.json() as { schedule: { timezone: string } }).schedule.timezone).toBe("Europe/Paris");
    });

    it("run env carries GIT_AUTHOR_NAME (employee name) and DEFAULT_TZ for the tools server", async () => {
      const { taskId } = await taskAndToken();
      const spec = await buildRunSpec(taskId, { employeeId: "dev", roleId: "assistant", prompt: "x", source: { channel: "http" } });
      expect(spec.env.GIT_AUTHOR_NAME).toBe("Dev Bot");
      const tools = (JSON.parse(spec.env.MCP_CONFIG!) as { mcpServers: { ai_employee: { env: Record<string, string> } } }).mcpServers.ai_employee;
      expect(tools.env.DEFAULT_TZ).toBe(deps().config.DEFAULT_TZ);
    });

    it("rejects a cron firing more often than every 15 minutes (400)", async () => {
      const { headers } = await taskAndToken();
      const res = await app.inject({ method: "POST", url: "/schedules", headers, payload: { name: "too-often", cron: "*/5 * * * *", prompt: "x" } });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a role without the schedules capability (403)", async () => {
      const { headers } = await taskAndToken("ops"); // ops has no capabilities
      const res = await app.inject({ method: "POST", url: "/schedules", headers, payload: { name: "nope", cron: "0 * * * *", prompt: "x" } });
      expect(res.statusCode).toBe(403);
    });

    it("rejects scheduling for a role not in canSchedule (403)", async () => {
      const { headers } = await taskAndToken(); // assistant: canSchedule = ["ops"]
      const res = await app.inject({ method: "POST", url: "/schedules", headers, payload: { name: "nope2", cron: "0 * * * *", prompt: "x", roleId: "developer" } });
      expect(res.statusCode).toBe(403);
    });

    it("allows scheduling for a role in canSchedule", async () => {
      const { headers } = await taskAndToken();
      const res = await app.inject({
        method: "POST", url: "/schedules", headers,
        payload: { name: "ops-check", cron: "0 * * * *", prompt: "x", roleId: "ops", deliverTo: { channel: "clickup", threadRef: "abc123" } },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { schedule: { role_id: string } }).schedule.role_id).toBe("ops");
    });

    it("rejects a duplicate name for the same employee (409, use delete_schedule first)", async () => {
      const { headers } = await taskAndToken();
      const res = await app.inject({ method: "POST", url: "/schedules", headers, payload: { name: "digest", cron: "0 * * * *", prompt: "x" } });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain("delete_schedule first");
    });

    it("rejects a bad run token (401)", async () => {
      const res = await app.inject({ method: "GET", url: "/schedules", headers: { authorization: "Bearer nope", "x-task-id": "nope" } });
      expect(res.statusCode).toBe(401);
    });

    it("fires a due schedule exactly once per next_fire_at", async () => {
      const digest = (await ledger.listSchedules("dev")).find((s) => s.name === "digest")!;
      const now = new Date(digest.next_fire_at);

      const started = await fireDueSchedules(now);
      const taskId = `cron:${digest.id}:${now.toISOString()}`;
      expect(started).toContain(taskId);
      const t = await waitFor(taskId, ["done", "failed"]);
      expect(t.status).toBe("done");

      const again = await fireDueSchedules(now);
      expect(again).not.toContain(taskId);
    }, 30_000);

    it("lists schedules for an employee without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/employees/dev/schedules" });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { name: string }[];
      expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["digest", "ops-check"]));
    });

    it("deletes a schedule scoped to the calling employee (204), then 404 on repeat", async () => {
      const { headers } = await taskAndToken();
      const digest = (await ledger.listSchedules("dev")).find((s) => s.name === "digest")!;
      const res = await app.inject({ method: "DELETE", url: `/schedules/${digest.id}`, headers });
      expect(res.statusCode).toBe(204);
      const again = await app.inject({ method: "DELETE", url: `/schedules/${digest.id}`, headers });
      expect(again.statusCode).toBe(404);
    });

    it("enforces max 20 enabled schedules per employee (409)", async () => {
      const { headers } = await taskAndToken();
      // Clean slate: DELETE scopes by employeeId only, so any of this employee's tokens may clear prior tests' rows.
      for (const s of await ledger.listSchedules("dev")) await app.inject({ method: "DELETE", url: `/schedules/${s.id}`, headers });
      for (let i = 0; i < 20; i++) {
        const res = await app.inject({
          method: "POST", url: "/schedules", headers,
          payload: { name: `quota-${i}`, cron: "0 * * * *", prompt: "x", deliverTo: { channel: "clickup", threadRef: "quota" } },
        });
        expect(res.statusCode).toBe(201);
      }
      const res = await app.inject({
        method: "POST", url: "/schedules", headers,
        payload: { name: "quota-21", cron: "0 * * * *", prompt: "x", deliverTo: { channel: "clickup", threadRef: "quota" } },
      });
      expect(res.statusCode).toBe(409);
    }, 30_000);
  });

  describe("child agents (POST /agents)", () => {
    async function taskAndToken(roleId?: string) {
      const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", roleId, prompt: "noop", taskKey: randomUUID() } });
      const { taskId } = res.json() as { taskId: string };
      const token = await ledger.issueRunToken(taskId, 600);
      return { taskId, headers: { authorization: `Bearer ${token}`, "x-task-id": taskId } };
    }

    it("spawns a child by role, runs it to done, and the parent reads the result via GET /agents/:id with no ClickUp post", async () => {
      const { taskId: parentId, headers } = await taskAndToken(); // assistant: capability agents, canSpawn ["ops","assistant"]
      const commentsBefore = clickup.comments.length;
      const chatBefore = clickup.chatMessages.length;

      const spawn = await app.inject({ method: "POST", url: "/agents", headers, payload: { role: "ops", brief: "child task" } });
      expect(spawn.statusCode).toBe(201);
      const { agentId, role, status } = spawn.json() as { agentId: string; role: string; status: string };
      expect(agentId).toMatch(new RegExp(`^agent:${parentId}:`));
      expect(role).toBe("ops");
      expect(status).toBe("queued");

      const t = await waitFor(agentId, ["done", "failed"]);
      expect(t.status).toBe("done");
      expect(t.parent_task_id).toBe(parentId);
      expect(t.depth).toBe(1);

      const got = await app.inject({ method: "GET", url: `/agents/${agentId}`, headers });
      expect(got.statusCode).toBe(200);
      const body = got.json() as { status: string; result?: { text: string } };
      expect(body.status).toBe("done");
      expect(body.result?.text).toBe("echo: child task");

      // no channel to post to for a child task
      expect(clickup.comments).toHaveLength(commentsBefore);
      expect(clickup.chatMessages).toHaveLength(chatBefore);

      const list = await app.inject({ method: "GET", url: "/agents", headers });
      expect((list.json() as { agents: { agentId: string }[] }).agents.map((a) => a.agentId)).toContain(agentId);
    }, 30_000);

    it("403s when the caller role lacks the agents capability", async () => {
      const { headers } = await taskAndToken("ops"); // ops has no capabilities
      const res = await app.inject({ method: "POST", url: "/agents", headers, payload: { role: "ops", brief: "x" } });
      expect(res.statusCode).toBe(403);
    });

    it("403s when the target role is not in the caller role's canSpawn", async () => {
      const { headers } = await taskAndToken(); // assistant: canSpawn = ["ops","assistant"], not "developer"
      const res = await app.inject({ method: "POST", url: "/agents", headers, payload: { role: "developer", brief: "x" } });
      expect(res.statusCode).toBe(403);
    });

    it("409s at max depth on a grandchild spawning its own child", async () => {
      const { headers: rootHeaders } = await taskAndToken(); // depth 0
      const gen1 = await app.inject({ method: "POST", url: "/agents", headers: rootHeaders, payload: { role: "assistant", brief: "gen1" } });
      const { agentId: gen1Id } = gen1.json() as { agentId: string };
      const gen1Headers = { authorization: `Bearer ${await ledger.issueRunToken(gen1Id, 600)}`, "x-task-id": gen1Id };

      const gen2 = await app.inject({ method: "POST", url: "/agents", headers: gen1Headers, payload: { role: "assistant", brief: "gen2" } });
      expect(gen2.statusCode).toBe(201); // depth 2, still within the max
      const { agentId: gen2Id } = gen2.json() as { agentId: string };
      const gen2Headers = { authorization: `Bearer ${await ledger.issueRunToken(gen2Id, 600)}`, "x-task-id": gen2Id };

      const gen3 = await app.inject({ method: "POST", url: "/agents", headers: gen2Headers, payload: { role: "assistant", brief: "gen3" } });
      expect(gen3.statusCode).toBe(409);
      expect((gen3.json() as { error: string }).error).toBe("max depth");
    });

    it("GET /agents/:id/events returns the child's event stream to its parent only, filtered by since", async () => {
      const { headers } = await taskAndToken();
      const spawn = await app.inject({ method: "POST", url: "/agents", headers, payload: { role: "ops", brief: "introspect me" } });
      const { agentId } = spawn.json() as { agentId: string };
      await waitFor(agentId, ["done", "failed"]);

      const all = await app.inject({ method: "GET", url: `/agents/${agentId}/events`, headers });
      expect(all.statusCode).toBe(200);
      const body = all.json() as { status: string; events: { seq: number; type: string }[] };
      expect(body.status).toBe("done");
      expect(body.events.length).toBeGreaterThan(1);
      expect(body.events.map((e) => e.type)).toContain("result");
      const firstSeq = body.events[0]!.seq;

      const rest = await app.inject({ method: "GET", url: `/agents/${agentId}/events?since=${firstSeq}`, headers });
      expect((rest.json() as { events: { seq: number }[] }).events.every((e) => e.seq > firstSeq)).toBe(true);

      // another task is not this child's parent → 404
      const { headers: stranger } = await taskAndToken();
      expect((await app.inject({ method: "GET", url: `/agents/${agentId}/events`, headers: stranger })).statusCode).toBe(404);
    }, 30_000);

    it("POST /agents/:id/cancel is parent-only and a no-op 202 on a finished child", async () => {
      const { headers } = await taskAndToken();
      const spawn = await app.inject({ method: "POST", url: "/agents", headers, payload: { role: "ops", brief: "cancel me" } });
      const { agentId } = spawn.json() as { agentId: string };
      await waitFor(agentId, ["done", "failed"]);

      const { headers: stranger } = await taskAndToken();
      expect((await app.inject({ method: "POST", url: `/agents/${agentId}/cancel`, headers: stranger })).statusCode).toBe(404);

      const res = await app.inject({ method: "POST", url: `/agents/${agentId}/cancel`, headers });
      expect(res.statusCode).toBe(202);
      expect((res.json() as { status: string }).status).toBe("done");
    }, 30_000);

    it("agents stay visible to the next message in the same chat, not just the task that spawned them", async () => {
      // Reproduces 2026-09-18: each chat message is its own task, so scoping agent lookups to the calling
      // task made a resumed session report that its own subagents had "silently dropped".
      const chatCfg = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, CLICKUP_CHAT_SECRET: "vis", CLICKUP_TEAM_ID: "1234567", SANDBOX_RUNTIME: "local" });
      const chatApp = buildServer({ config: chatCfg, ledger, orchestrator: new DbosOrchestrator(ledger), employees: new Map([[employee.id, employee]]), slack, clickup });
      const post = (id: string, content: string) =>
        chatApp.inject({ method: "POST", url: "/clickup/chat", headers: { "x-bot-secret": "vis" }, payload: { id, channel_id: "vis-chan", content } });

      await post("v1", "first question");
      const first = await waitFor("clickup-chat:vis-chan:v1", ["done"]);
      const firstHeaders = { authorization: `Bearer ${await ledger.issueRunToken(first.id, 600)}`, "x-task-id": first.id };
      const spawn = await chatApp.inject({ method: "POST", url: "/agents", headers: firstHeaders, payload: { role: "ops", brief: "long job" } });
      const { agentId } = spawn.json() as { agentId: string };
      await waitFor(agentId, ["done", "failed"]);

      // second message in the same channel → new task, same conversation
      await post("v2", "did that finish?");
      const second = await waitFor("clickup-chat:vis-chan:v2", ["done"]);
      expect(second.id).not.toBe(first.id);
      expect(second.conversation_id).toBe(first.conversation_id);
      const secondHeaders = { authorization: `Bearer ${await ledger.issueRunToken(second.id, 600)}`, "x-task-id": second.id };

      const list = await chatApp.inject({ method: "GET", url: "/agents", headers: secondHeaders });
      expect((list.json() as { agents: { agentId: string }[] }).agents.map((a) => a.agentId)).toContain(agentId);
      expect((await chatApp.inject({ method: "GET", url: `/agents/${agentId}`, headers: secondHeaders })).statusCode).toBe(200);
      expect((await chatApp.inject({ method: "GET", url: `/agents/${agentId}/events`, headers: secondHeaders })).statusCode).toBe(200);

      // a different conversation still cannot see it
      await post("v3", "unrelated");
      const other = await waitFor("clickup-chat:vis-chan:v3", ["done"]);
      void other;
      const { headers: strangerHeaders } = await taskAndToken();
      expect((await chatApp.inject({ method: "GET", url: `/agents/${agentId}`, headers: strangerHeaders })).statusCode).toBe(404);
      await chatApp.close();
    }, 45_000);

    it("a child whose parent already finished relays its result to the root ClickUp thread (fire-and-forget escalation)", async () => {
      const rootId = "clickup-chat:relay-chan:root";
      await ledger.createTask(rootId, { employeeId: "dev", roleId: "assistant", prompt: "root", source: { channel: "clickup-chat", threadRef: "relay-chan", quiet: true } });
      const rootHeaders = { authorization: `Bearer ${await ledger.issueRunToken(rootId, 600)}`, "x-task-id": rootId };
      await ledger.setStatus(rootId, "done", { result: { text: "P2 degraded — investigating" } });

      const before = clickup.chatMessages.filter((m) => m.channelId === "relay-chan").length;
      const spawn = await app.inject({ method: "POST", url: "/agents", headers: rootHeaders, payload: { role: "ops", brief: "root cause found, PR #9 opened" } });
      expect(spawn.statusCode).toBe(201);
      const { agentId } = spawn.json() as { agentId: string };
      await waitFor(agentId, ["done", "failed"]);

      const relayed = clickup.chatMessages.filter((m) => m.channelId === "relay-chan");
      expect(relayed).toHaveLength(before + 1);
      expect(relayed.at(-1)!.text).toContain("Follow-up from ops");
      expect(relayed.at(-1)!.text).toContain("echo: root cause found, PR #9 opened");
    }, 30_000);

    it("ask/answer: a child asks a question, it lands in the origin ClickUp chat, and the reply routes back to it", async () => {
      const rootId = "clickup-chat:ask-chan-1:root";
      await ledger.createTask(rootId, { employeeId: "dev", roleId: "assistant", prompt: "root prompt", source: { channel: "clickup-chat", threadRef: "ask-chan-1" } });
      const rootHeaders = { authorization: `Bearer ${await ledger.issueRunToken(rootId, 600)}`, "x-task-id": rootId };

      const spawn = await app.inject({ method: "POST", url: "/agents", headers: rootHeaders, payload: { role: "ops", brief: "asker child" } });
      const { agentId } = spawn.json() as { agentId: string };
      const agentHeaders = { authorization: `Bearer ${await ledger.issueRunToken(agentId, 600)}`, "x-task-id": agentId };

      const ask = await app.inject({ method: "POST", url: "/agents/self/ask", headers: agentHeaders, payload: { question: "what should I do?" } });
      expect(ask.statusCode).toBe(202);
      expect((await ledger.getTask(agentId))!.status).toBe("awaiting_input");

      const askMsgs = clickup.chatMessages.filter((m) => m.channelId === "ask-chan-1");
      expect(askMsgs).toHaveLength(1);
      expect(askMsgs[0]!.text.startsWith("\u{1F916} ")).toBe(true);
      expect(askMsgs[0]!.text).toBe("\u{1F916} what should I do?");

      const cfg = loadConfig({ DATABASE_URL: TEST_DB_URL, DBOS_SYSTEM_DATABASE_URL: TEST_DBOS_URL, CLICKUP_CHAT_SECRET: "ask-secret", CLICKUP_TEAM_ID: "1234567", SANDBOX_RUNTIME: "local" });
      const chatApp = buildServer({ config: cfg, ledger, orchestrator: new DbosOrchestrator(ledger), employees: new Map([[employee.id, employee]]), slack, clickup });
      const reply = await chatApp.inject({
        method: "POST", url: "/clickup/chat", headers: { "x-bot-secret": "ask-secret" },
        payload: { id: "amsg1", channel_id: "ask-chan-1", content: "the answer is 42" },
      });
      expect(reply.statusCode).toBe(200);
      expect((reply.json() as { routedTo?: string }).routedTo).toBe(agentId);
      await chatApp.close();

      const answer = await app.inject({ method: "GET", url: "/agents/self/answer", headers: agentHeaders });
      expect(answer.statusCode).toBe(200);
      expect((answer.json() as { answer: string }).answer).toBe("the answer is 42");

      const after = await ledger.getTask(agentId);
      expect(after!.status).toBe("running");
      expect(after!.question).toBeNull();
      expect(after!.answer).toBeNull();
    }, 30_000);
  });

  describe("monitors (default off, toggled by the agent, model only on new findings)", () => {
    async function taskAndToken(roleId?: string) {
      const res = await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", roleId, prompt: "noop", taskKey: randomUUID() } });
      const { taskId } = res.json() as { taskId: string };
      const token = await ledger.issueRunToken(taskId, 600);
      return { taskId, headers: { authorization: `Bearer ${token}`, "x-task-id": taskId } };
    }

    it("lists as off, enables via POST, runs its collector on the tick helpers, fires only on new messages, disables again", async () => {
      const { headers } = await taskAndToken(); // assistant: capability monitors
      const t0 = new Date("2026-09-17T12:00:00Z");

      const list0 = await app.inject({ method: "GET", url: "/monitors", headers });
      expect(list0.statusCode).toBe(200);
      expect((list0.json() as { monitors: { name: string; enabled: boolean }[] }).monitors).toEqual([expect.objectContaining({ name: "support-watch", enabled: false, collector: "clickup-channels" })]);
      expect(await monitors.listDueMonitors(t0)).toEqual([]); // off → never due

      const on = await app.inject({ method: "POST", url: "/monitors/support-watch/enable", headers });
      expect(on.statusCode).toBe(200);
      expect((on.json() as { enabled: boolean }).enabled).toBe(true);
      expect((await app.inject({ method: "POST", url: "/monitors/nope/enable", headers })).statusCode).toBe(404);

      // run 1: baseline only, no task
      clickup.history.set("sup-1", [{ id: "500", text: "old message", userId: "3" }]);
      let due = await monitors.listDueMonitors(t0);
      expect(due.map((d) => d.name)).toEqual(["support-watch"]);
      let r = await monitors.collectSafely(due[0]!, t0);
      expect(r.findings).toEqual([]);
      await monitors.saveRun(due[0]!, r.state, t0, false);

      // 1 minute later: interval not elapsed → not due
      expect(await monitors.listDueMonitors(new Date(t0.getTime() + 60_000))).toEqual([]);

      // run 2 (5 min later): a new human message → finding → quiet task for the monitor's role
      clickup.history.set("sup-1", [{ id: "501", text: "Acme: all sends failing since 11:50", userId: "3" }, { id: "500", text: "old message", userId: "3" }]);
      const t1 = new Date(t0.getTime() + 5 * 60_000);
      due = await monitors.listDueMonitors(t1);
      expect(due).toHaveLength(1);
      r = await monitors.collectSafely(due[0]!, t1);
      expect(r.findings.map((f) => f.text)).toEqual(["#us-support user 3: Acme: all sends failing since 11:50"]);
      const { taskId, input } = monitors.taskFor(due[0]!, r.findings, t1);
      expect(taskId).toBe("monitor:dev:support-watch:2026-09-17T12:05");
      expect(input.roleId).toBe("ops");
      expect(input.source.quiet).toBe(true);
      expect(input.prompt).toContain("Acme: all sends failing");
      await monitors.saveRun(due[0]!, r.state, t1, true);
      const row = await ledger.getMonitor("dev", "support-watch");
      expect(row?.last_fired_at?.toISOString()).toBe(t1.toISOString());

      // a quiet task posts nothing when the triage answer is NOISE
      const chatBefore = clickup.chatMessages.length;
      await app.inject({ method: "POST", url: "/tasks", payload: { employeeId: "dev", roleId: "ops", prompt: "NOISE", taskKey: "quiet-noise" } });
      await waitFor("http:dev:quiet-noise", ["done"]);
      expect(clickup.chatMessages).toHaveLength(chatBefore);

      const off = await app.inject({ method: "POST", url: "/monitors/support-watch/disable", headers });
      expect((off.json() as { enabled: boolean }).enabled).toBe(false);
      expect(await monitors.listDueMonitors(new Date(t1.getTime() + 10 * 60_000))).toEqual([]);

      // a role without the capability is refused
      const { headers: opsHeaders } = await taskAndToken("ops");
      expect((await app.inject({ method: "GET", url: "/monitors", headers: opsHeaders })).statusCode).toBe(403);
    }, 30_000);
  });

  describe("usage stats and failure alerts", () => {
    let prevConfig: ReturnType<typeof deps>["config"];

    beforeAll(() => {
      prevConfig = deps().config;
      setWorkflowDeps({ ...deps(), config: { ...prevConfig, ALERT_CHANNEL_ID: "alert-chan" } });
    });
    afterAll(() => {
      setWorkflowDeps({ ...deps(), config: prevConfig });
    });

    it("GET /stats returns totals across tasks already run, with a byRole entry", async () => {
      const res = await app.inject({ method: "GET", url: "/stats?since=1d" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { totals: { tasks: number }; byRole: { role: string }[] };
      expect(body.totals.tasks).toBeGreaterThanOrEqual(2);
      expect(body.byRole.some((r) => r.role === "assistant")).toBe(true);
    });

    it("GET /employees/:id/stats scopes to that employee", async () => {
      const res = await app.inject({ method: "GET", url: "/employees/dev/stats?since=1d" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { totals: { tasks: number } }).totals.tasks).toBeGreaterThanOrEqual(2);
      expect((await app.inject({ method: "GET", url: "/employees/nope/stats" })).statusCode).toBe(404);
    });

    it("posts a one-line failure alert to ALERT_CHANNEL_ID for a failed cron-origin task", async () => {
      const orchestrator = new DbosOrchestrator(ledger);
      const taskId = `cron:test-alert:${randomUUID()}`;
      await orchestrator.startTask(taskId, {
        employeeId: "dev",
        roleId: "assistant",
        prompt: "please FAIL",
        source: { channel: "cron", threadRef: "sched-1" },
      });
      const t = await waitFor(taskId, ["done", "failed"]);
      expect(t.status).toBe("failed");

      const alert = clickup.chatMessages.find((m) => m.channelId === "alert-chan");
      expect(alert).toBeDefined();
      expect(alert!.text).toContain("⚠️");
      expect(alert!.text).toContain("assistant run failed");
      expect(alert!.text).toContain(taskId); // the full id, so a human can look the run up
      expect(alert!.text).toContain("exit 7"); // the fake runner's code; summarize() names the cause
    }, 30_000);
  });
});
