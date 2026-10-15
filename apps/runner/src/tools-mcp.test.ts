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
  it("lists exactly the schedule and agent-delegation tools", async () => {
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
        "create_schedule",
        "delete_schedule",
        "disable_monitor",
        "enable_monitor",
        "list_agents",
        "list_monitors",
        "list_schedules",
        "list_tasks",
        "spawn_agent",
        "start_workstream",
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
});
