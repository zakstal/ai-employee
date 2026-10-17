import { execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distToolsMcp = path.join(pkgRoot, "dist", "tools-mcp.js");

beforeAll(() => {
  execSync("tsc -b tsconfig.json", { cwd: pkgRoot, stdio: "inherit" });
}, 60_000);

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  taskId: string | undefined;
  body: unknown;
}

interface FakeControlPlane {
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function fakeControlPlane(handler: (req: RecordedRequest, res: http.ServerResponse) => void): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      const record: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        taskId: Array.isArray(req.headers["x-task-id"]) ? req.headers["x-task-id"][0] : req.headers["x-task-id"],
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(record);
      handler(record, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
      resolve({ port: address.port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function connectClient(port: number): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distToolsMcp],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      RUN_TOKEN: "test-run-token",
      TASK_ID: "task-1",
      AI_EMPLOYEE_POLL_MS: "20",
    },
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function firstText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content[0]?.text ?? "";
}

describe("ai_employee MCP tools", () => {
  it("lists exactly the schedule, agent-delegation, messaging, status and operator tools", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "agent_events",
        "ask_human",
        "cancel_agent",
        "cancel_task",
        "claude_settings",
        "create_schedule",
        "delete_schedule",
        "disable_monitor",
        "employee_status",
        "enable_monitor",
        "list_agents",
        "list_monitors",
        "list_schedules",
        "list_tasks",
        "message_owner",
        "note_for_owner_session",
        "read_messages",
        "send_message",
        "spawn_agent",
        "start_task",
        "start_workstream",
        "task_events",
        "task_logs",
        "task_runtime",
        "usage_status",
        "wait_for",
      ]);
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("create_schedule POSTs the right JSON with both auth headers and returns text with the name", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schedule: {
            id: "sch_1",
            name: "daily-report",
            cron: "0 9 * * *",
            timezone: "America/Los_Angeles",
            role_id: null,
            prompt: "send it",
            next_fire_at: "2026-09-15T16:00:00.000Z",
          },
        }),
      );
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({
        name: "create_schedule",
        arguments: { name: "daily-report", cron: "0 9 * * *", prompt: "send it" },
      });
      expect(cp.requests).toHaveLength(1);
      expect(cp.requests[0]?.method).toBe("POST");
      expect(cp.requests[0]?.url).toBe("/schedules");
      expect(cp.requests[0]?.authorization).toBe("Bearer test-run-token");
      expect(cp.requests[0]?.taskId).toBe("task-1");
      expect(cp.requests[0]?.body).toEqual({
        name: "daily-report",
        cron: "0 9 * * *",
        prompt: "send it",
        timezone: "America/Los_Angeles",
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("daily-report");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("surfaces a control-plane 400 as isError with the error text", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "minimum interval is 15 minutes" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({
        name: "create_schedule",
        arguments: { name: "too-often", cron: "* * * * *", prompt: "spam" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("minimum interval is 15 minutes");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("list_schedules GETs /schedules and returns a table", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schedules: [
            {
              id: "sch_1",
              name: "daily-report",
              cron: "0 9 * * *",
              timezone: "America/Los_Angeles",
              prompt: "send it",
              next_fire_at: "2026-09-15T16:00:00.000Z",
            },
          ],
        }),
      );
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "list_schedules" });
      expect(cp.requests[0]?.method).toBe("GET");
      expect(cp.requests[0]?.url).toBe("/schedules");
      expect(firstText(result)).toContain("daily-report");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("delete_schedule sends DELETE to /schedules/:id", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "delete_schedule", arguments: { id: "sch_1" } });
      expect(cp.requests).toHaveLength(1);
      expect(cp.requests[0]?.method).toBe("DELETE");
      expect(cp.requests[0]?.url).toBe("/schedules/sch_1");
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("sch_1");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("spawn_agent POSTs role+brief with both auth headers and returns the agent id", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "ag_1", role: "researcher", status: "queued" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { role: "researcher", brief: "find the bug" },
      });
      expect(cp.requests).toHaveLength(1);
      expect(cp.requests[0]?.method).toBe("POST");
      expect(cp.requests[0]?.url).toBe("/agents");
      expect(cp.requests[0]?.authorization).toBe("Bearer test-run-token");
      expect(cp.requests[0]?.taskId).toBe("task-1");
      expect(cp.requests[0]?.body).toEqual({ role: "researcher", brief: "find the bug" });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe("Spawned researcher agent ag_1.");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("wait_for polls until the fake flips status to done on the 2nd poll", async () => {
    let calls = 0;
    const cp = await fakeControlPlane((req, res) => {
      if (req.method === "GET" && req.url === "/agents/ag_1") {
        calls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        if (calls < 2) {
          res.end(JSON.stringify({ agentId: "ag_1", status: "running" }));
        } else {
          res.end(JSON.stringify({ agentId: "ag_1", status: "done", result: { text: "all fixed" } }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "wait_for", arguments: { agent_id: "ag_1" } });
      expect(calls).toBe(2);
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("all fixed");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("wait_for returns early on awaiting_input with the question", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "ag_2", status: "awaiting_input", question: "which env?" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "wait_for", arguments: { agent_id: "ag_2" } });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("which env?");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("ask_human posts the question then returns the answer after one 204", async () => {
    let answerCalls = 0;
    const cp = await fakeControlPlane((req, res) => {
      if (req.method === "POST" && req.url === "/agents/self/ask") {
        res.writeHead(202, { "content-type": "application/json" });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/agents/self/answer") {
        answerCalls += 1;
        if (answerCalls < 2) {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ answer: "yes, go ahead" }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({
        name: "ask_human",
        arguments: { question: "can I deploy?" },
      });
      const asks = cp.requests.filter((r) => r.url === "/agents/self/ask");
      expect(asks).toHaveLength(1);
      expect(asks[0]?.body).toEqual({ question: "can I deploy?" });
      expect(answerCalls).toBe(2);
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe("yes, go ahead");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("list_agents GETs /agents and returns a table", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [{ agentId: "ag_1", role: "researcher", status: "done", result: { text: "all fixed" } }],
        }),
      );
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "list_agents" });
      expect(cp.requests[0]?.method).toBe("GET");
      expect(cp.requests[0]?.url).toBe("/agents");
      expect(firstText(result)).toContain("ag_1");
      expect(firstText(result)).toContain("researcher");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("enable_monitor POSTs /monitors/:name/enable and list_monitors renders a table", async () => {
    const cp = await fakeControlPlane((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST") res.end(JSON.stringify({ name: "azure-errors", collector: "azure-errors", everyMin: 5, role: "monitor-triage", enabled: true }));
      else res.end(JSON.stringify({ monitors: [{ name: "azure-errors", collector: "azure-errors", everyMin: 5, role: "monitor-triage", enabled: false, description: "Azure sweep" }] }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const on = await client.callTool({ name: "enable_monitor", arguments: { name: "azure-errors" } });
      expect(cp.requests[0]?.method).toBe("POST");
      expect(cp.requests[0]?.url).toBe("/monitors/azure-errors/enable");
      expect(firstText(on)).toContain("azure-errors is now ON");
      const list = await client.callTool({ name: "list_monitors" });
      expect(cp.requests[1]?.url).toBe("/monitors");
      expect(firstText(list)).toContain("azure-errors | off | every 5 min");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("cancel_agent POSTs /agents/:id/cancel and reports the status", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "ag_9", status: "cancelling" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "cancel_agent", arguments: { agent_id: "ag_9" } });
      expect(cp.requests[0]?.method).toBe("POST");
      expect(cp.requests[0]?.url).toBe("/agents/ag_9/cancel");
      expect(cp.requests[0]?.taskId).toBe("task-1");
      expect(firstText(result)).toBe("Agent ag_9: cancelling.");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("agent_events GETs /agents/:id/events with since/limit and renders one row per event", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agentId: "ag_2",
          status: "running",
          events: [
            { seq: 4, type: "tool_use", ts: "t", tool: "Bash", input: { command: "pnpm test" } },
            { seq: 5, type: "assistant_text", ts: "t", text: "Tests pass, opening the PR." },
          ],
        }),
      );
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "agent_events", arguments: { agent_id: "ag_2", since_seq: 3, limit: 10 } });
      expect(cp.requests[0]?.method).toBe("GET");
      expect(cp.requests[0]?.url).toBe("/agents/ag_2/events?since=3&limit=10");
      const text = firstText(result);
      expect(text).toContain("Agent ag_2 is running.");
      expect(text).toContain("4 | tool_use | Bash");
      expect(text).toContain("pnpm test");
      expect(text).toContain("5 | assistant_text | Tests pass");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("send_message POSTs channel/text/to and reports the id", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 7 }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "send_message", arguments: { channel: "repo.x", text: "claiming a.ts", to: "ag_1" } });
      expect(cp.requests[0]?.method).toBe("POST");
      expect(cp.requests[0]?.url).toBe("/agents/self/messages");
      expect(cp.requests[0]?.authorization).toBe("Bearer test-run-token");
      expect(cp.requests[0]?.taskId).toBe("task-1");
      expect(cp.requests[0]?.body).toEqual({ channel: "repo.x", text: "claiming a.ts", to: "ag_1" });
      expect(firstText(result)).toBe("Sent message 7 on repo.x.");
      const bad = await client.callTool({ name: "send_message", arguments: { channel: "Bad Channel", text: "x" } });
      expect(bad.isError).toBe(true);
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("read_messages GETs with since/wait and renders one row per message", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [{ id: 8, from: "ag_2", to: null, text: "fix pushed", createdAt: "2026-10-16T00:00:00Z", message: {} }] }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "read_messages", arguments: { channel: "repo.x", since: 5, wait_seconds: 10 } });
      expect(cp.requests[0]?.method).toBe("GET");
      expect(cp.requests[0]?.url).toBe("/agents/self/messages?channel=repo.x&since=5&wait=10");
      expect(firstText(result)).toContain("8 | ag_2 | everyone | 2026-10-16T00:00:00Z | fix pushed");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("read_messages says so when the channel is quiet", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messages: [] }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({ name: "read_messages", arguments: { channel: "repo.x" } });
      expect(cp.requests[0]?.url).toBe("/agents/self/messages?channel=repo.x&since=0&wait=0");
      expect(firstText(result)).toBe("No new messages on repo.x.");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("usage_status GETs /agents/self/usage and renders one row per account", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          currentAccount: "work",
          settings: { limitPolicy: "failover-then-wait", allowOverage: false, warnAt: 0.8, preferred: [] },
          accounts: [
            { name: "work", available: true, fiveHour: { status: "allowed", utilization: 0.85, resetsAt: "2026-10-16T17:40:00.000Z" }, sevenDay: { status: "allowed", utilization: 0.4, resetsAt: null }, overage: { status: "rejected", utilization: 0 }, checkedAt: "2026-10-16T12:00:00.000Z", lastError: null },
            { name: "personal", available: false, availableAgainAt: "2026-10-16T18:00:00.000Z", fiveHour: { status: "rejected", utilization: 1, resetsAt: "2026-10-16T18:00:00.000Z" }, sevenDay: { status: null, utilization: null, resetsAt: null }, overage: { status: null, utilization: null }, checkedAt: null, lastError: "network down" },
          ],
        }),
      );
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const text = firstText(await client.callTool({ name: "usage_status", arguments: {} }));
      expect(cp.requests[0]?.method).toBe("GET");
      expect(cp.requests[0]?.url).toBe("/agents/self/usage");
      expect(text).toContain("limit policy: failover-then-wait; overage not allowed");
      expect(text).toContain("work (this task) | available | 5h 85% resets 2026-10-16T17:40:00.000Z | 7d 40% resets ?");
      expect(text).toContain("personal | at limit until 2026-10-16T18:00:00.000Z | 5h 100%");
      expect(text).toContain("(last error: network down)");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("usage_status says so when no accounts are configured", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ currentAccount: null, settings: { limitPolicy: "off", allowOverage: false, warnAt: 0.8, preferred: [] }, accounts: [] }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      expect(firstText(await client.callTool({ name: "usage_status", arguments: {} }))).toBe("No Claude subscription accounts are configured.");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("spawn_agent forwards backlog and item for a manager dispatch", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "ag_2", role: "implement", status: "queued" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      await client.callTool({ name: "spawn_agent", arguments: { role: "implement", brief: "notes", backlog: "bl", item: "button" } });
      expect(cp.requests[0]?.body).toEqual({ role: "implement", brief: "notes", backlog: "bl", item: "button" });
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  it("surfaces a control-plane 403 from spawn_agent as isError with the error text", async () => {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "role not permitted" }));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = await client.callTool({
        name: "spawn_agent",
        arguments: { role: "admin", brief: "do admin things" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("role not permitted");
    } finally {
      await close();
      await cp.close();
    }
  }, 20_000);

  /** Run one tool against a fake control plane; returns what the control plane saw and what the model would read. */
  async function call(name: string, args: Record<string, unknown>, reply: { status?: number; body: unknown }) {
    const cp = await fakeControlPlane((_req, res) => {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    const { client, close } = await connectClient(cp.port);
    try {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
      return { req: cp.requests[0]!, text: firstText(result), isError: result.isError === true };
    } finally {
      await close();
      await cp.close();
    }
  }

  it("employee_status GETs /agents/self/status and renders the compact report", async () => {
    const r = await call("employee_status", {}, {
      body: {
        employee: "dev", now: "2026-10-16T12:00:00.000Z", currentTask: "http:dev:me",
        active: [{ id: "telegram:5", role: "assistant", status: "running", channel: "telegram", parent: null, root: "telegram:5", startedAt: "x", updatedAt: "y", ageSec: 300, account: "work", costUsd: null, progress: "reading the migration" }],
        finished: [{ id: "cron:1", role: "ops", status: "failed", channel: "cron", finishedAt: "2026-10-16T11:00:00.000Z", costUsd: 0.5, result: "Task failed: boom" }],
        claude: { currentAccount: null, settings: { limitPolicy: "wait", allowOverage: false, warnAt: 0.8, preferred: [] }, accounts: [] },
      },
    });
    expect(r.req).toMatchObject({ method: "GET", url: "/agents/self/status", authorization: "Bearer test-run-token", taskId: "task-1" });
    expect(r.text).toContain("telegram:5 | assistant | running | telegram | root | 5m | work | - | reading the migration");
    expect(r.text).toContain("cron:1 | ops | failed | cron | 2026-10-16T11:00:00.000Z | $0.50 | Task failed: boom");
    expect(r.isError).toBe(false);
  }, 20_000);

  it("message_owner POSTs the text and reports the channel; a rate-limit or no-channel error comes back as an error result", async () => {
    const ok = await call("message_owner", { text: "build is green" }, { status: 201, body: { ok: true, channel: "telegram", parts: 2 } });
    expect(ok.req).toMatchObject({ method: "POST", url: "/agents/self/message-owner", body: { text: "build is green" } });
    expect(ok.text).toBe("Sent to the owner via telegram (2 parts).");
    const limited = await call("message_owner", { text: "again" }, { status: 429, body: { error: "at most 20 owner messages per hour per task" } });
    expect(limited).toMatchObject({ isError: true, text: "at most 20 owner messages per hour per task" });
  }, 20_000);

  it("start_task POSTs /operator/tasks with replyTo mapped from reply_to; a role without `operate` gets the clear 403 text", async () => {
    const ok = await call("start_task", { role: "worker", prompt: "do it", task_key: "k", reply_to: "telegram" }, { status: 202, body: { taskId: "http:dev:k", started: true, status: "queued" } });
    expect(ok.req).toMatchObject({ method: "POST", url: "/operator/tasks", body: { role: "worker", prompt: "do it", taskKey: "k", replyTo: { channel: "telegram" } } });
    expect(ok.text).toBe("Started worker task http:dev:k.");
    const plain = await call("start_task", { role: "worker", prompt: "do it" }, { status: 202, body: { taskId: "http:dev:z", started: true, status: "queued" } });
    expect(plain.req.body).toEqual({ role: "worker", prompt: "do it" });
    const dup = await call("start_task", { role: "worker", prompt: "do it", task_key: "k" }, { status: 200, body: { taskId: "http:dev:k", started: false, status: "running" } });
    expect(dup.text).toContain("already exists (running)");
    const denied = await call("start_task", { role: "worker", prompt: "x" }, { status: 403, body: { error: 'role assistant lacks the "operate" capability' } });
    expect(denied).toMatchObject({ isError: true, text: 'role assistant lacks the "operate" capability' });
  }, 40_000);

  it("cancel_task POSTs /operator/tasks/:id/cancel", async () => {
    const r = await call("cancel_task", { task_id: "slack:T:C:1.2" }, { status: 202, body: { taskId: "slack:T:C:1.2", status: "cancelling" } });
    expect(r.req).toMatchObject({ method: "POST", url: "/operator/tasks/slack%3AT%3AC%3A1.2/cancel" });
    expect(r.text).toBe("Task slack:T:C:1.2: cancelling.");
  }, 20_000);

  it("task_events GETs /operator/tasks/:id/events with since/limit and renders rows", async () => {
    const r = await call("task_events", { task_id: "t1", since_seq: 3, limit: 5 }, {
      body: { taskId: "t1", role: "worker", status: "running", events: [{ seq: 4, type: "assistant_text", ts: "t", text: "hello" }, { seq: 5, type: "tool_use", ts: "t", tool: "Read", input: { file_path: "a" } }] },
    });
    expect(r.req).toMatchObject({ method: "GET", url: "/operator/tasks/t1/events?since=3&limit=5" });
    expect(r.text).toContain("Task t1 (worker) is running.");
    expect(r.text).toContain("4 | assistant_text | hello");
    expect(r.text).toContain("5 | tool_use | Read ");
    const none = await call("task_events", { task_id: "t1" }, { body: { taskId: "t1", role: "worker", status: "done", events: [] } });
    expect(none.req.url).toBe("/operator/tasks/t1/events?since=0&limit=30");
    expect(none.text).toBe("Task t1 (worker) is done; no new events.");
  }, 40_000);

  it("task_runtime GETs /operator/tasks/:id/runtime and renders adapter, state, times, exit code; says so when there is no sandbox or the adapter could not tell", async () => {
    const ended = await call("task_runtime", { task_id: "agent:t1:x" }, {
      body: { taskId: "agent:t1:x", role: "supervisor", status: "running", sandbox: { adapter: "cloudrun", externalId: "projects/p/locations/r/jobs/j/executions/e1", state: "ended", startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:09:00.000Z", exitCode: 1, reason: "ContainerFailed" } },
    });
    expect(ended.req).toMatchObject({ method: "GET", url: "/operator/tasks/agent%3At1%3Ax/runtime" });
    expect(ended.text).toBe([
      "Task agent:t1:x (supervisor) is running in the ledger.",
      "sandbox: cloudrun projects/p/locations/r/jobs/j/executions/e1 is ENDED",
      "started: 2026-10-17T10:00:00.000Z",
      "ended: 2026-10-17T10:09:00.000Z",
      "exit code: 1 (ContainerFailed)",
    ].join("\n"));
    const none = await call("task_runtime", { task_id: "t2" }, { body: { taskId: "t2", role: "worker", status: "queued", sandbox: { adapter: null, externalId: null, state: "not_started" } } });
    expect(none.text).toContain("not started yet");
    const unknown = await call("task_runtime", { task_id: "t3" }, { body: { taskId: "t3", role: "worker", status: "running", sandbox: { adapter: "local", externalId: "t3", state: "unknown", error: "the local adapter cannot report sandbox status" } } });
    expect(unknown.text).toContain("is UNKNOWN");
    expect(unknown.text).toContain("could not tell: the local adapter cannot report sandbox status");
    const denied = await call("task_runtime", { task_id: "t4" }, { status: 403, body: { error: 'role assistant lacks the "operate" capability' } });
    expect(denied).toMatchObject({ isError: true, text: 'role assistant lacks the "operate" capability' });
  }, 40_000);

  it("task_logs GETs /operator/tasks/:id/logs?tail= (default 100) and prints the lines; an adapter without logs comes back as an error", async () => {
    const r = await call("task_logs", { task_id: "t1", tail: 3 }, { body: { taskId: "t1", adapter: "warm", externalId: "t1", lines: ["a", "b", "c"] } });
    expect(r.req).toMatchObject({ method: "GET", url: "/operator/tasks/t1/logs?tail=3" });
    expect(r.text).toBe("Last 3 log lines of task t1 (warm t1):\na\nb\nc");
    const dflt = await call("task_logs", { task_id: "t1" }, { body: { taskId: "t1", adapter: "warm", externalId: "t1", lines: [] } });
    expect(dflt.req.url).toBe("/operator/tasks/t1/logs?tail=100");
    expect(dflt.text).toContain("No log lines");
    const long = await call("task_logs", { task_id: "t1" }, { body: { taskId: "t1", adapter: "warm", externalId: "t1", lines: ["x".repeat(3000)] } });
    expect(long.text.length).toBeLessThan(1200);
    const unsupported = await call("task_logs", { task_id: "t1" }, { status: 501, body: { error: "the local adapter cannot provide sandbox logs; use task_events for what the agent did" } });
    expect(unsupported).toMatchObject({ isError: true, text: expect.stringContaining("cannot provide sandbox logs") });
  }, 40_000);

  it("note_for_owner_session POSTs /agents/self/owner-note and says nothing was sent to a chat", async () => {
    const r = await call("note_for_owner_session", { text: "run pnpm gen:build billing locally" }, { status: 201, body: { id: 12 } });
    expect(r.req).toMatchObject({ method: "POST", url: "/agents/self/owner-note", body: { text: "run pnpm gen:build billing locally" } });
    expect(r.text).toBe("Noted for the owner's local session (note 12). Nothing was sent to a chat.");
    const limited = await call("note_for_owner_session", { text: "again" }, { status: 429, body: { error: "at most 50 notes per task" } });
    expect(limited).toMatchObject({ isError: true, text: "at most 50 notes per task" });
  }, 40_000);

  it("claude_settings: get is a GET, set is a PUT of only the passed fields, validation errors come back as errors", async () => {
    const settings = { limitPolicy: "wait", allowOverage: true, warnAt: 0.7, preferred: ["work"] };
    const get = await call("claude_settings", { action: "get" }, { body: settings });
    expect(get.req).toMatchObject({ method: "GET", url: "/operator/settings/claude" });
    expect(get.text).toBe("limitPolicy wait; allowOverage true; warnAt 0.7; preferred work.");
    const set = await call("claude_settings", { action: "set", allowOverage: true, warnAt: 0.7 }, { body: settings });
    expect(set.req).toMatchObject({ method: "PUT", url: "/operator/settings/claude", body: { allowOverage: true, warnAt: 0.7 } });
    expect(set.text.startsWith("Updated. ")).toBe(true);
    const bad = await call("claude_settings", { action: "set" }, { status: 400, body: { error: "no settings given" } });
    expect(bad).toMatchObject({ isError: true, text: "no settings given" });
  }, 40_000);

  it("list_tasks still reads /tasks/recent (any role)", async () => {
    const r = await call("list_tasks", { since_hours: 24 }, { body: { tasks: [{ id: "a", role: "ops", status: "done", parent: null, updatedAt: "t", result: "ok" }] } });
    expect(r.req.url).toBe("/tasks/recent?since=24&limit=100");
    expect(r.text).toContain("a | ops | done | root | ok");
  }, 20_000);
});
