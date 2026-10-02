#!/usr/bin/env node
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Stdio MCP server letting the agent manage its own cron schedules via the
 * control plane. Base URL + auth come from env set by the runner (same
 * RUN_TOKEN/TASK_ID used for the event sink); read lazily per call so
 * `listTools` works even before those are wired up.
 */

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const envPollMs = Number(process.env.AI_EMPLOYEE_POLL_MS);
const AGENT_POLL_MS = envPollMs || 3000;
const ANSWER_POLL_MS = envPollMs || 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Agent {
  agentId: string;
  role?: string;
  status: "queued" | "running" | "awaiting_input" | "done" | "failed" | "cancelled";
  result?: { text: string };
  question?: string;
}

interface Schedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  role_id?: string | null;
  prompt: string;
  deliver_to?: unknown;
  next_fire_at: string;
}

function envOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const baseUrl = envOrThrow("CONTROL_PLANE_URL");
  const token = envOrThrow("RUN_TOKEN");
  const taskId = envOrThrow("TASK_ID");

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-task-id": taskId,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return undefined;
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = (parsed as { error?: string } | undefined)?.error ?? `control plane returned ${res.status}`;
    throw new Error(message);
  }
  return parsed;
}

// ponytail: covers the common every-N-minutes/hours, daily, and weekly
// patterns; anything else falls back to the raw crontab string. Upgrade to a
// cron-to-English library if users hit unusual expressions often.
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const pad = (n: string) => n.padStart(2, "0");
  if (dom === "*" && mon === "*" && dow === "*") {
    if (/^\*\/\d+$/.test(min) && hour === "*") return `every ${min.slice(2)} minutes`;
    if (min === "0" && /^\*\/\d+$/.test(hour)) return `every ${hour.slice(2)} hours`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return `daily at ${pad(hour)}:${pad(min)}`;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dom === "*" && mon === "*" && /^\d+$/.test(min) && /^\d+$/.test(hour) && /^[0-6]$/.test(dow)) {
    return `weekly on ${days[Number(dow)]} at ${pad(hour)}:${pad(min)}`;
  }
  return cron;
}

function formatInTz(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function renderTable(schedules: Schedule[]): string {
  if (schedules.length === 0) return "No schedules.";
  const header = "name | id | cron | timezone | next fire";
  const sep = "--- | --- | --- | --- | ---";
  const rows = schedules.map(
    (s) => `${s.name} | ${s.id} | ${describeCron(s.cron)} | ${s.timezone} | ${formatInTz(s.next_fire_at, s.timezone)}`,
  );
  return [header, sep, ...rows].join("\n");
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
}

const server = new McpServer({ name: "ai_employee", version: "0.0.1" });

server.registerTool(
  "create_schedule",
  {
    description:
      "Create a recurring job that runs `prompt` as a task on the given cron (minimum every 15 minutes) " +
      "and posts the result back to the channel this conversation is in. Confirm the schedule to the user " +
      "in plain words after creating it.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9-]{3,40}$/, "must be a lowercase slug, 3-40 chars, [a-z0-9-]"),
      cron: z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, "must be a 5-field crontab expression"),
      prompt: z.string().min(1),
      role: z.string().optional(),
      timezone: z.string().optional(),
    },
  },
  async ({ name, cron, prompt, role, timezone }): Promise<CallToolResult> => {
    try {
      const tz = timezone ?? DEFAULT_TIMEZONE;
      const body = (await request("POST", "/schedules", {
        name,
        cron,
        prompt,
        timezone: tz,
        ...(role ? { roleId: role } : {}),
      })) as { schedule: Schedule };
      const s = body.schedule;
      return textResult(
        `Created schedule "${s.name}" — ${describeCron(s.cron)} (${s.timezone}). Next run: ${formatInTz(s.next_fire_at, s.timezone)}.`,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_schedules",
  { description: "List all recurring jobs currently scheduled for this agent." },
  async (): Promise<CallToolResult> => {
    try {
      const body = (await request("GET", "/schedules")) as { schedules: Schedule[] };
      return textResult(renderTable(body.schedules));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "delete_schedule",
  { description: "Delete a scheduled recurring job by id.", inputSchema: { id: z.string().min(1) } },
  async ({ id }): Promise<CallToolResult> => {
    try {
      await request("DELETE", `/schedules/${encodeURIComponent(id)}`);
      return textResult(`Deleted schedule ${id}.`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function spawn(body: { role?: string; workstream?: string; brief: string }): Promise<CallToolResult> {
  try {
    const agent = (await request("POST", "/agents", body)) as Agent;
    return textResult(`Spawned ${agent.role ?? body.workstream ?? "agent"} agent ${agent.agentId}.`);
  } catch (err) {
    return errorResult(err);
  }
}

interface MonitorView {
  name: string;
  collector: string;
  everyMin: number;
  role: string;
  description?: string;
  enabled: boolean;
  lastRunAt?: string | null;
  lastFiredAt?: string | null;
}

function monitorTable(monitors: MonitorView[]): string {
  if (monitors.length === 0) return "No monitors are defined for this employee.";
  const rows = monitors.map((m) => `${m.name} | ${m.enabled ? "ON" : "off"} | every ${m.everyMin} min | ${m.collector} | last run ${m.lastRunAt ?? "never"} | ${m.description ?? ""}`);
  return ["name | state | interval | collector | last run | description", "--- | --- | --- | --- | --- | ---", ...rows].join("\n");
}

server.registerTool(
  "list_tasks",
  {
    description:
      "Every recent task for this employee, not just your own children: what ran, which role, how it ended. " +
      "Use it to establish what is actually done before dispatching anything. Requires the backlog capability.",
    inputSchema: { since_hours: z.number().int().positive().max(336).optional(), limit: z.number().int().positive().max(500).optional() },
  },
  async ({ since_hours, limit }): Promise<CallToolResult> => {
    try {
      const qs = new URLSearchParams({ since: String(since_hours ?? 48), limit: String(limit ?? 100) });
      const body = (await request("GET", `/tasks/recent?${qs}`)) as {
        tasks: Array<{ id: string; role: string; status: string; parent: string | null; updatedAt: string; result: string }>;
      };
      if (body.tasks.length === 0) return textResult("No tasks in that window.");
      const rows = body.tasks.map((t) => `${t.id} | ${t.role} | ${t.status} | ${t.parent ? "child" : "root"} | ${t.result.slice(0, 80).replace(/\n/g, " ")}`);
      return textResult(["id | role | status | kind | result", "--- | --- | --- | --- | ---", ...rows].join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_monitors",
  { description: "List background monitors (Azure error sweeps, ClickUp channel watchers) and whether each is on. They are OFF by default." },
  async (): Promise<CallToolResult> => {
    try {
      const body = (await request("GET", "/monitors")) as { monitors: MonitorView[] };
      return textResult(monitorTable(body.monitors));
    } catch (err) {
      return errorResult(err);
    }
  },
);

for (const action of ["enable", "disable"] as const) {
  server.registerTool(
    `${action}_monitor`,
    {
      description:
        action === "enable"
          ? "Turn a background monitor ON. Its collector then runs on its interval with no model cost; a triage task (and tokens) happens only when it finds something new."
          : "Turn a background monitor OFF. Nothing is collected or spent until it is enabled again.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }): Promise<CallToolResult> => {
      try {
        const m = (await request("POST", `/monitors/${encodeURIComponent(name)}/${action}`, {})) as MonitorView;
        return textResult(`Monitor ${m.name} is now ${m.enabled ? "ON" : "off"} (every ${m.everyMin} min, ${m.collector}).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

server.registerTool(
  "spawn_agent",
  {
    description:
      "Delegate a piece of work to a subagent running as its own task in its own sandbox. Give a complete " +
      "brief: the request, links, findings so far, decisions already made, and what to return. Returns an " +
      "agent id; use wait_for to get the result. Subagents keep their own context; send follow-ups to the " +
      "same agent via spawn_agent again with the previous agent id in the brief.",
    inputSchema: { role: z.string(), brief: z.string().min(1) },
  },
  async ({ role, brief }): Promise<CallToolResult> => spawn({ role, brief }),
);

server.registerTool(
  "start_workstream",
  {
    description:
      "Start a named multi-stage workstream (e.g. \"sdlc\") as a subagent flow running in its own sandbox. " +
      "Give a complete brief: the request, links, findings so far, decisions already made, and what to " +
      "return. Returns the parent agent id; use wait_for to get the result.",
    inputSchema: { workstream: z.string(), brief: z.string().min(1) },
  },
  async ({ workstream, brief }): Promise<CallToolResult> => spawn({ workstream, brief }),
);

server.registerTool(
  "wait_for",
  {
    description:
      "Poll a spawned agent or workstream until it finishes or asks a question. Returns the result text on " +
      "done, the question on awaiting_input, or a non-error status message if it times out.",
    inputSchema: {
      agent_id: z.string().min(1),
      timeout_sec: z.number().int().positive().max(3600).optional(),
    },
  },
  async ({ agent_id, timeout_sec }): Promise<CallToolResult> => {
    const timeoutMs = (timeout_sec ?? 900) * 1000;
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const agent = (await request("GET", `/agents/${encodeURIComponent(agent_id)}`)) as Agent;
        if (agent.status === "awaiting_input") {
          return textResult(`Agent ${agent_id} is awaiting input: ${agent.question ?? ""}`);
        }
        if (agent.status === "done" || agent.status === "failed" || agent.status === "cancelled") {
          return textResult(`Agent ${agent_id} ${agent.status}: ${agent.result?.text ?? ""}`);
        }
        if (Date.now() >= deadline) {
          return textResult(`still running after ${timeout_sec ?? 900} s; call wait_for again`);
        }
        await sleep(AGENT_POLL_MS);
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "cancel_agent",
  {
    description: "Stop a spawned agent or workstream you no longer need. Its sandbox is torn down; wait_for then reports cancelled.",
    inputSchema: { agent_id: z.string().min(1) },
  },
  async ({ agent_id }): Promise<CallToolResult> => {
    try {
      const r = (await request("POST", `/agents/${encodeURIComponent(agent_id)}/cancel`, {})) as { status: string };
      return textResult(`Agent ${agent_id}: ${r.status}.`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

interface AgentEvent {
  seq: number;
  type: string;
  ts: string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  message?: string;
  code?: number;
}

function summarizeEvent(e: AgentEvent): string {
  const clip = (v: unknown, n: number) => {
    const str = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return str.length > n ? `${str.slice(0, n)}…` : str;
  };
  switch (e.type) {
    case "tool_use":
      return `${e.tool ?? "tool"} ${clip(e.input, 120)}`;
    case "tool_result":
      return `${e.isError ? "ERROR " : ""}${clip(e.output, 120)}`;
    case "assistant_text":
    case "result":
      return clip(e.text, 200);
    case "error":
      return clip(e.message, 200);
    case "exit":
      return `code ${e.code ?? "?"}`;
    default:
      return "";
  }
}

server.registerTool(
  "agent_events",
  {
    description:
      "Introspect a spawned agent while it runs: its recent events (tool calls, results, text). Pass since_seq " +
      "from the last event you saw to get only what is new. Use to check progress before deciding to wait, " +
      "re-brief, or cancel.",
    inputSchema: {
      agent_id: z.string().min(1),
      since_seq: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
  },
  async ({ agent_id, since_seq, limit }): Promise<CallToolResult> => {
    try {
      const qs = new URLSearchParams({ since: String(since_seq ?? 0), limit: String(limit ?? 30) });
      const body = (await request("GET", `/agents/${encodeURIComponent(agent_id)}/events?${qs}`)) as {
        status: string;
        events: AgentEvent[];
      };
      if (body.events.length === 0) return textResult(`Agent ${agent_id} is ${body.status}; no new events.`);
      const rows = body.events.map((e) => `${e.seq} | ${e.type} | ${summarizeEvent(e)}`);
      return textResult([`Agent ${agent_id} is ${body.status}.`, "seq | type | detail", ...rows].join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "list_agents",
  { description: "List all spawned agents and workstreams with their current status." },
  async (): Promise<CallToolResult> => {
    try {
      const body = (await request("GET", "/agents")) as { agents: Agent[] } | Agent[];
      const agents = Array.isArray(body) ? body : body.agents;
      if (agents.length === 0) return textResult("No agents.");
      const excerpt = (a: Agent) => (a.result?.text ?? a.question ?? "").slice(0, 60);
      const header = "id | role | status | result/question";
      const sep = "--- | --- | --- | ---";
      const rows = agents.map((a) => `${a.agentId} | ${a.role ?? ""} | ${a.status} | ${excerpt(a)}`);
      return textResult([header, sep, ...rows].join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "ask_human",
  {
    description:
      "Use only when you genuinely need a human decision (spec approval, ambiguous requirement, permission " +
      "to change production). The question is posted to the human's thread and this task pauses until they " +
      "reply.",
    inputSchema: {
      question: z.string().min(1),
      timeout_sec: z.number().int().positive().max(7200).optional(),
      repost: z.boolean().optional(),
    },
  },
  async ({ question, timeout_sec, repost }): Promise<CallToolResult> => {
    const timeoutMs = (timeout_sec ?? 1800) * 1000;
    const deadline = Date.now() + timeoutMs;
    try {
      if (repost !== false) {
        await request("POST", "/agents/self/ask", { question });
      }
      for (;;) {
        const res = (await request("GET", "/agents/self/answer")) as { answer: string } | undefined;
        if (res !== undefined) return textResult(res.answer);
        if (Date.now() >= deadline) {
          return textResult(
            `no answer yet after ${timeout_sec ?? 1800} s; the task stays parked — call ask_human again with the same question to keep waiting`,
          );
        }
        await sleep(ANSWER_POLL_MS);
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

await server.connect(new StdioServerTransport());
