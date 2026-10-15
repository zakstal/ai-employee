import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveRole, roleGrants, type Employee, type Orchestrator, type Role, type RunnerEvent } from "@ai-employee/core";
import type { Config } from "../config.js";
import { randomBase62, type DeliverTo, type Ledger, type TaskRow } from "../db/ledger.js";
import { verifySlackSignature } from "../slack/verify.js";
import type { SlackClient } from "../slack/client.js";
import { verifyClickUpSignature } from "../clickup/verify.js";
import { clickUpTrigger, type ClickUpWebhook } from "../clickup/webhook.js";
import { chatTrigger, BOT_MARKER } from "../clickup/chat.js";
import type { ClickUpClient } from "../clickup/client.js";
import { backlogOverview, checkDispatchGuards } from "../backlogs/guards.js";
import { briefFor } from "../backlogs/render.js";
import { fill } from "../backlogs/state.js";
import { validateCron } from "../schedules/cron.js";
import { providerFor } from "../credentials/index.js";
import { deps as workflowDeps } from "../orchestration/deps.js";
import { RUN_HTML } from "./run.html.js";
import { STATUS_HTML } from "./status.html.js";

export interface ServerDeps {
  config: Config;
  ledger: Ledger;
  orchestrator: Orchestrator;
  employees: Map<string, Employee>;
  slack: SlackClient;
  clickup: ClickUpClient;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const RunnerEventsBody = z.object({
  events: z.array(z.object({ runId: z.string(), seq: z.number().int(), ts: z.string(), type: z.string() }).passthrough()).max(500),
});

const CreateTaskBody = z.object({
  employeeId: z.string().min(1),
  roleId: z.string().optional(),
  prompt: z.string().min(1),
  /** Caller-chosen dedup key. Omit for a fresh task every call. */
  taskKey: z.string().optional(),
  /**
   * Hand this task to a manager role: when it reaches a terminal state the manager is woken to
   * decide what happens next. Without it, HTTP-dispatched work is invisible to the manager, which
   * is why multi-stage efforts have had to be driven by a script outside the system.
   */
  managedBy: z.string().min(1).optional(),
});

const CreateScheduleBody = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  roleId: z.string().optional(),
  timezone: z.string().optional(),
  deliverTo: z.object({ channel: z.string(), threadRef: z.string() }).optional(),
});

const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_input"]);

const MAX_ENABLED_SCHEDULES = 20;
const MAX_SPAWN_DEPTH = 2;
const MAX_ACTIVE_CHILDREN = 4;
const MAX_CREDENTIAL_REFRESHES = 60; // per run; a refresh returns a live token
const ASK_LONG_POLL_MS = 25_000;

const CreateAgentBody = z
  .object({
    role: z.string().min(1).optional(),
    workstream: z.string().min(1).optional(),
    brief: z.string().min(1),
    /** Manager only: dispatch `item` of the configured backlog. The system fills the backlog's brief template and counts the task against its limits. */
    backlog: z.string().min(1).optional(),
    item: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  })
  .refine((b) => Number(!!b.role) + Number(!!b.workstream) === 1, { message: "exactly one of role or workstream is required" })
  .refine((b) => !!b.backlog === !!b.item, { message: "backlog and item go together" })
  .refine((b) => !b.backlog || !!b.role, { message: "a backlog item is dispatched by role, not workstream" });

const AskBody = z.object({ question: z.string().min(1) });

interface AgentAuth {
  taskId: string;
  employee: Employee;
  role: Role;
  source: DeliverTo;
  depth: number;
  /** Agent lookups are scoped to this when set, so they survive the next message in the same chat. */
  conversationId: string | null;
}

/** Bearer run token + X-Task-Id → the task's employee, its role, and its deliverTo default. Replies 401 and returns undefined on failure. */
async function authenticateAgent(
  req: FastifyRequest,
  reply: FastifyReply,
  ledger: Ledger,
  employees: Map<string, Employee>,
): Promise<AgentAuth | undefined> {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const taskId = req.headers["x-task-id"] as string | undefined;
  const fail = () => {
    reply.code(401).send({ error: "bad run token" });
    return undefined;
  };
  if (!token || !taskId || !(await ledger.verifyRunToken(taskId, token))) return fail();
  const task = await ledger.getTask(taskId);
  const employee = task ? employees.get(task.employee_id) : undefined;
  if (!task || !employee) return fail();
  return {
    taskId,
    employee,
    role: resolveRole(employee, task.role_id),
    source: { channel: task.source.channel, threadRef: task.source.threadRef ?? "" },
    depth: task.depth,
    conversationId: task.conversation_id,
  };
}

/** Walk parent_task_id up to the root (human-triggered) task and return its row. */
async function findRootTask(ledger: Ledger, taskId: string): Promise<TaskRow> {
  let t = await ledger.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  while (t.parent_task_id) {
    const parent = await ledger.getTask(t.parent_task_id);
    if (!parent) break;
    t = parent;
  }
  return t;
}

/** `since`: an ISO timestamp, or `<N>d` for N days ago (default `7d`). `until`: an ISO timestamp, default now. */
function parseStatsRange(query: { since?: string; until?: string }): { since: Date; until: Date } | undefined {
  const until = query.until ? new Date(query.until) : new Date();
  const days = /^(\d+)d$/.exec(query.since ?? "7d");
  const since = days ? new Date(Date.now() - Number(days[1]) * 86_400_000) : new Date(query.since ?? "7d");
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return undefined;
  return { since, until };
}

const WARM_FETCH_TIMEOUT_MS = 2000;

/** The warm runner's own `GET /runs` payload, or `{ error }` if it's unreachable. Never throws. */
async function fetchWarmRuns(config: Config): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.WARM_RUNNER_URL}/runs`, {
      headers: { authorization: `Bearer ${config.RUNNER_TOKEN}` },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `runner responded ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function activeTaskView(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id,
    role: t.role_id,
    status: t.status,
    parent_task_id: t.parent_task_id,
    depth: t.depth,
    created_at: t.created_at,
    updated_at: t.updated_at,
    adapter: t.run_handle?.adapter ?? null,
    externalId: t.run_handle?.externalId ?? null,
    prompt: t.prompt.slice(0, 80),
    ...(t.status === "awaiting_input" && t.question ? { question: t.question } : {}),
  };
}

function recentTaskView(t: TaskRow): Record<string, unknown> {
  const result = t.result as { text?: string; costUsd?: number } | null;
  return {
    id: t.id,
    role: t.role_id,
    status: t.status,
    parent_task_id: t.parent_task_id,
    created_at: t.created_at,
    updated_at: t.updated_at,
    adapter: t.run_handle?.adapter ?? null,
    costUsd: result?.costUsd ?? null,
    // additive: the status page's "last 5 failed" panel needs a snippet of why.
    ...(t.status === "failed" && result?.text ? { resultText: result.text.slice(0, 100) } : {}),
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, ledger, orchestrator, employees, slack, clickup } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // Keep the raw body: Slack signatures are computed over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse((body as Buffer).toString("utf8")) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  // Both paths: Google's front end intercepts *z-suffixed paths on run.app URLs (returns its own 404),
  // so external checks use /health; /healthz stays for local scripts and in-cluster probes.
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));

  // ---- generic HTTP trigger (also what tests and cron will use)
  app.post("/tasks", async (req, reply) => {
    const body = CreateTaskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const employee = employees.get(body.data.employeeId);
    if (!employee) return reply.code(404).send({ error: "unknown employee" });
    const taskId = `http:${employee.id}:${body.data.taskKey ?? randomUUID()}`;
    const res = await orchestrator.startTask(taskId, {
      employeeId: employee.id,
      roleId: body.data.roleId ?? employee.defaultRole,
      prompt: body.data.prompt,
      source: body.data.managedBy ? { channel: "http", managedBy: body.data.managedBy } : { channel: "http" },
    });
    return reply.code(res.started ? 202 : 200).send({ taskId, ...res });
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    const t = await ledger.getTask(req.params.id);
    return t ? t : reply.code(404).send({ error: "not found" });
  });
  app.get<{ Params: { id: string } }>("/tasks/:id/events", async (req) => ledger.listEvents(req.params.id));
  app.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (req) => {
    await orchestrator.cancel(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { active?: string } }>("/employees/:id/tasks", async (req, reply) => {
    if (!employees.has(req.params.id)) return reply.code(404).send({ error: "unknown employee" });
    return ledger.listTasks(req.params.id, { activeOnly: req.query.active === "1" });
  });

  // ---- usage/cost stats
  app.get<{ Querystring: { since?: string; until?: string } }>("/stats", async (req, reply) => {
    const range = parseStatsRange(req.query);
    if (!range) return reply.code(400).send({ error: "bad since/until" });
    return ledger.stats(undefined, range.since, range.until);
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string; until?: string } }>("/employees/:id/stats", async (req, reply) => {
    if (!employees.has(req.params.id)) return reply.code(404).send({ error: "unknown employee" });
    const range = parseStatsRange(req.query);
    if (!range) return reply.code(400).send({ error: "bad since/until" });
    return ledger.stats(req.params.id, range.since, range.until);
  });

  // ---- live status page (no auth: read-only operational view)
  app.get("/runtime", async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [warm, active, recent] = await Promise.all([fetchWarmRuns(config), ledger.activeTasks(), ledger.recentTasks(since)]);
    const backlogs = (await Promise.all([...employees.values()].map((e) => backlogOverview({ ledger, config }, e)))).flat();
    return { warm, active: active.map(activeTaskView), recent: recent.map(recentTaskView), backlogs };
  });

  app.get("/runs/:id/view", async (_req, reply) => {
    reply.type("text/html").send(RUN_HTML); // the page reads the task id back out of the path
  });

  app.get("/status", async (_req, reply) => {
    reply.type("text/html").send(STATUS_HTML);
  });

  // ---- agent-creatable cron schedules (auth: Bearer <run token> + X-Task-Id, scoped to that task's employee)
  app.post("/schedules", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const body = CreateScheduleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { employee, role, taskId, source } = auth;

    if (!role.capabilities.includes("schedules")) return reply.code(403).send({ error: `role ${role.id} lacks the "schedules" capability` });

    const targetRoleId = body.data.roleId ?? role.id;
    if (targetRoleId !== role.id && !role.canSchedule.includes(targetRoleId)) {
      return reply.code(403).send({ error: `role ${role.id} may not create schedules for role ${targetRoleId}` });
    }
    if (!employee.roles.some((r) => r.id === targetRoleId)) return reply.code(400).send({ error: `employee ${employee.id} has no role ${targetRoleId}` });

    const timezone = body.data.timezone ?? config.DEFAULT_TZ;
    const cronCheck = validateCron(body.data.cron, timezone);
    if (!cronCheck.ok) return reply.code(400).send({ error: cronCheck.error });

    const existing = await ledger.listSchedules(employee.id);
    if (existing.filter((s) => s.enabled && s.source === "runtime").length >= MAX_ENABLED_SCHEDULES) return reply.code(409).send({ error: `max ${MAX_ENABLED_SCHEDULES} enabled schedules per employee` });
    if (existing.some((s) => s.name === body.data.name)) return reply.code(409).send({ error: `schedule "${body.data.name}" already exists; use delete_schedule first` });

    const deliverTo: DeliverTo = body.data.deliverTo ?? source;
    if ((deliverTo.channel !== "clickup" && deliverTo.channel !== "clickup-chat") || !deliverTo.threadRef) {
      return reply.code(400).send({ error: "deliverTo must be clickup or clickup-chat with a threadRef" });
    }

    const schedule = await ledger.createSchedule({
      employeeId: employee.id,
      name: body.data.name,
      cron: body.data.cron,
      timezone,
      roleId: targetRoleId,
      prompt: body.data.prompt,
      deliverTo,
      createdByTask: taskId,
      nextFireAt: cronCheck.nextTwo[0]!,
    });
    return reply.code(201).send({ schedule });
  });

  app.get("/schedules", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    return { schedules: await ledger.listSchedules(auth.employee.id) };
  });

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const row = await ledger.getSchedule(req.params.id);
    if (row?.employee_id === auth.employee.id && row.source === "config") return reply.code(409).send({ error: "defined in config; edit the employee file" });
    const deleted = await ledger.deleteSchedule(req.params.id, auth.employee.id);
    if (!deleted) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  // ---- monitors: defined in the employee YAML, toggled here (auth: Bearer <run token> + X-Task-Id; capability "monitors")
  const monitorView = (employee: Employee, name: string, row?: { enabled: boolean; last_run_at: Date | null; last_fired_at: Date | null }) => {
    const m = employee.monitors[name]!;
    return { name, collector: m.collector, everyMin: m.everyMin, role: m.role, description: m.description, enabled: row?.enabled ?? false, lastRunAt: row?.last_run_at ?? null, lastFiredAt: row?.last_fired_at ?? null };
  };
  app.get("/monitors", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    if (!auth.role.capabilities.includes("monitors")) return reply.code(403).send({ error: `role ${auth.role.id} lacks the "monitors" capability` });
    const rows = new Map((await ledger.listMonitors(auth.employee.id)).map((r) => [r.name, r]));
    return { monitors: Object.keys(auth.employee.monitors).map((name) => monitorView(auth.employee, name, rows.get(name))) };
  });
  app.post<{ Params: { name: string; action: string } }>("/monitors/:name/:action", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    if (!auth.role.capabilities.includes("monitors")) return reply.code(403).send({ error: `role ${auth.role.id} lacks the "monitors" capability` });
    const { name, action } = req.params;
    if (!auth.employee.monitors[name]) return reply.code(404).send({ error: `no monitor "${name}"; known: ${Object.keys(auth.employee.monitors).join(", ") || "none"}` });
    if (action !== "enable" && action !== "disable") return reply.code(400).send({ error: "action must be enable or disable" });
    const row = await ledger.setMonitorEnabled(auth.employee.id, name, action === "enable", auth.taskId);
    return monitorView(auth.employee, name, row);
  });

  app.get<{ Params: { id: string } }>("/employees/:id/monitors", async (req, reply) => {
    if (!employees.has(req.params.id)) return reply.code(404).send({ error: "unknown employee" });
    const employee = employees.get(req.params.id)!;
    const rows = new Map((await ledger.listMonitors(employee.id)).map((r) => [r.name, r]));
    return { monitors: Object.keys(employee.monitors).map((name) => monitorView(employee, name, rows.get(name))) };
  });

  // Flow guards: state of each configured backlog, and the manual resume of a halted one (like POST /tasks, kept off the public internet by the API allowlist).
  app.get<{ Params: { id: string } }>("/employees/:id/backlogs", async (req, reply) => {
    const employee = employees.get(req.params.id);
    if (!employee) return reply.code(404).send({ error: "unknown employee" });
    return { backlogs: await backlogOverview({ ledger, config }, employee) };
  });

  app.post<{ Params: { id: string; backlog: string } }>("/employees/:id/backlogs/:backlog/resume", async (req, reply) => {
    const employee = employees.get(req.params.id);
    if (!employee?.backlogs?.[req.params.backlog]) return reply.code(404).send({ error: "unknown employee or backlog" });
    const resumed = await ledger.resumeBacklog(employee.id, req.params.backlog);
    return reply.code(resumed ? 200 : 409).send({ resumed });
  });

  app.get<{ Params: { id: string } }>("/employees/:id/schedules", async (req, reply) => {
    if (!employees.has(req.params.id)) return reply.code(404).send({ error: "unknown employee" });
    return ledger.listSchedules(req.params.id);
  });

  // ---- credential refresh: a long run asks for a fresh token of a grant it holds (auth: Bearer <run token> + X-Task-Id)
  // ponytail: in-memory count per run, lost on restart; persist if the cap ever has to survive one.
  const refreshes = new Map<string, number>();
  app.post("/credentials/:grant/refresh", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const { grant } = req.params as { grant: string };
    if (!roleGrants(auth.role).includes(grant)) return reply.code(403).send({ error: `role ${auth.role.id} has no grant "${grant}"` });
    const spec = auth.employee.credentials?.[grant];
    const provider = spec ? providerFor(spec) : undefined;
    if (!spec || !provider?.refreshable) return reply.code(404).send({ error: `credential "${grant}" cannot be refreshed` });
    const n = (refreshes.get(auth.taskId) ?? 0) + 1;
    if (n > MAX_CREDENTIAL_REFRESHES) return reply.code(429).send({ error: "too many refreshes for this run" });
    refreshes.set(auth.taskId, n);
    const { config, secrets } = workflowDeps();
    try {
      const r = await provider.resolve(grant, spec, { employee: auth.employee, role: auth.role, taskId: auth.taskId, config, secrets, fetch, now: () => new Date() });
      return { env: r.env, expiresAt: r.expiresAt?.toISOString() ?? null };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // ---- child agents: spawn a subagent as its own task (auth: Bearer <run token> + X-Task-Id)
  app.post("/agents", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const body = CreateAgentBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { employee, role, taskId: callerTaskId, source, depth } = auth;

    if (!role.capabilities.includes("agents")) return reply.code(403).send({ error: `role ${role.id} lacks the "agents" capability` });

    let targetRoleId: string;
    if (body.data.workstream) {
      const ws = employee.workstreams[body.data.workstream];
      if (!ws) return reply.code(400).send({ error: `employee ${employee.id} has no workstream ${body.data.workstream}` });
      targetRoleId = ws.entryRole;
    } else {
      targetRoleId = body.data.role!;
    }
    if (!role.canSpawn.includes(targetRoleId)) return reply.code(403).send({ error: `role ${role.id} may not spawn role ${targetRoleId}` });
    if (!employee.roles.some((r) => r.id === targetRoleId)) return reply.code(400).send({ error: `employee ${employee.id} has no role ${targetRoleId}` });

    // Backlog dispatch: only the manager, only the backlog's role, never a disabled backlog or an item already in flight.
    let brief = body.data.brief;
    let backlogSource: { managedBy: string; backlogId: string; backlogItem: string } | undefined;
    if (body.data.backlog) {
      const { backlog: id, item } = body.data as { backlog: string; item: string };
      if (!config.MANAGER_ROLE || role.id !== config.MANAGER_ROLE) return reply.code(403).send({ error: "only the manager role may dispatch backlog items" });
      const bl = employee.backlogs?.[id];
      if (!bl) return reply.code(400).send({ error: `employee ${employee.id} has no backlog ${id}` });
      if (targetRoleId !== bl.dispatch.role) return reply.code(400).send({ error: `backlog ${id} dispatches role ${bl.dispatch.role}, not ${targetRoleId}` });
      const guard = await checkDispatchGuards({ ledger, config, clickup }, employee, id, item);
      if (guard) return reply.code(409).send({ error: guard });
      if ((await ledger.tasksByBacklog(employee.id, id)).some((t) => t.item === item && ACTIVE_STATUSES.has(t.status))) return reply.code(409).send({ error: `guard: item ${item} is already running` });
      const notes = body.data.brief.trim();
      brief = `${briefFor(id, bl, item, fill(bl.done.branchPattern, { backlog: id, item }))}\n\nManager notes:\n${notes}`;
      backlogSource = { managedBy: role.id, backlogId: id, backlogItem: item };
    }

    const childDepth = depth + 1;
    if (childDepth > MAX_SPAWN_DEPTH) return reply.code(409).send({ error: "max depth" });
    if ((await ledger.countActiveChildren(callerTaskId)) >= MAX_ACTIVE_CHILDREN) return reply.code(409).send({ error: `max ${MAX_ACTIVE_CHILDREN} active children` });

    const agentId = `agent:${callerTaskId}:${randomBase62(8)}`;
    await orchestrator.startTask(agentId, {
      employeeId: employee.id,
      roleId: targetRoleId,
      prompt: brief,
      source: { channel: "child", parentTaskId: callerTaskId, threadRef: source.threadRef, originChannel: source.channel, depth: childDepth, ...(auth.conversationId ? { conversationId: auth.conversationId } : {}), ...backlogSource },
    });
    return reply.code(201).send({ agentId, role: targetRoleId, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const t = await visibleAgent(auth, req.params.id);
    if (!t) return reply.code(404).send({ error: "not found" });
    return {
      agentId: t.id,
      role: t.role_id,
      status: t.status,
      ...(t.status === "awaiting_input" && t.question ? { question: t.question } : {}),
      ...(t.result ? { result: { text: (t.result as { text?: string }).text } } : {}),
    };
  });

  /** Visible to the caller if it is its own child, or any agent from the same conversation (see listConversationAgents). */
  const visibleAgent = async (auth: AgentAuth, id: string) => {
    const t = await ledger.getTask(id);
    if (!t || !t.parent_task_id) return undefined;
    if (t.parent_task_id === auth.taskId) return t;
    if (auth.conversationId && t.conversation_id === auth.conversationId) return t;
    return undefined;
  };

  // Stop a child: same ownership rule as GET /agents/:id. Cancelling an already-finished child is a no-op 202.
  app.post<{ Params: { id: string } }>("/agents/:id/cancel", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const t = await visibleAgent(auth, req.params.id);
    if (!t) return reply.code(404).send({ error: "not found" });
    if (t.status === "done" || t.status === "failed" || t.status === "cancelled") return reply.code(202).send({ agentId: t.id, status: t.status });
    await orchestrator.cancel(t.id);
    return reply.code(202).send({ agentId: t.id, status: "cancelling" });
  });

  // Peek at a child's progress mid-run: its event stream after `since` (seq), newest last.
  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>("/agents/:id/events", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const t = await visibleAgent(auth, req.params.id);
    if (!t) return reply.code(404).send({ error: "not found" });
    const since = Number(req.query.since ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const events = (await ledger.listEvents(t.id)).filter((e) => e.seq > since);
    return { agentId: t.id, status: t.status, events: events.slice(-limit) };
  });

  // The manager coordinates work it did not spawn in this run, so it needs the employee's whole recent
  // history rather than its own children. Capability-gated: no other role gets it.
  app.get<{ Querystring: { since?: string; limit?: string } }>("/tasks/recent", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    if (!auth.role.capabilities.includes("backlog")) return reply.code(403).send({ error: `role ${auth.role.id} lacks the "backlog" capability` });
    const hours = Math.min(Number(req.query.since ?? 48) || 48, 24 * 14);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const rows = await ledger.recentTasksForEmployee(auth.employee.id, new Date(Date.now() - hours * 3600_000), limit);
    return {
      tasks: rows.map((t) => ({
        id: t.id,
        role: t.role_id,
        status: t.status,
        parent: t.parent_task_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        result: ((t.result as { text?: string } | null)?.text ?? "").slice(0, 400),
      })),
    };
  });

  app.get("/agents", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const children = auth.conversationId ? await ledger.listConversationAgents(auth.conversationId) : await ledger.listChildren(auth.taskId);
    return {
      agents: children.map((t) => ({
        agentId: t.id,
        role: t.role_id,
        status: t.status,
        ...(t.status === "awaiting_input" && t.question ? { question: t.question } : {}),
        ...(t.result ? { result: { text: (t.result as { text?: string }).text } } : {}),
      })),
    };
  });

  // Ask a question up the chain: posts to the root task's origin thread (ClickUp), or just records it for `http`.
  app.post("/agents/self/ask", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const body = AskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const root = await findRootTask(ledger, auth.taskId);
    const marked = `${BOT_MARKER}${body.data.question}`;
    try {
      if (root.source.channel === "clickup-chat" && root.source.threadRef) {
        await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, root.source.threadRef, marked);
      } else if (root.source.channel === "clickup" && root.source.threadRef) {
        await clickup.postComment(root.source.threadRef, marked);
      }
      // "http" (and any other) origin: no channel to post to, question is stored for the poller below.
    } catch (e) {
      app.log.warn(e, "failed to post agent question to origin thread");
    }

    await ledger.setQuestion(auth.taskId, body.data.question);
    await ledger.setStatus(auth.taskId, "awaiting_input");
    return reply.code(202).send({ ok: true });
  });

  // Long-poll (up to 25s) for the human's answer to a pending self/ask.
  app.get("/agents/self/answer", async (req, reply) => {
    const auth = await authenticateAgent(req, reply, ledger, employees);
    if (!auth) return;
    const deadline = Date.now() + ASK_LONG_POLL_MS;
    while (Date.now() < deadline) {
      const answer = await ledger.takeAnswer(auth.taskId);
      if (answer !== undefined) {
        await ledger.setStatus(auth.taskId, "running");
        return reply.send({ answer });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return reply.code(204).send();
  });

  // ---- event sink: runners push normalized events here
  app.post<{ Params: { id: string } }>("/runs/:id/events", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !(await ledger.verifyRunToken(req.params.id, token))) return reply.code(401).send({ error: "bad run token" });
    const body = RunnerEventsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    let accepted = 0;
    for (const ev of body.data.events) {
      if (ev.runId !== req.params.id) return reply.code(400).send({ error: "runId mismatch" });
      if (await ledger.appendEvent(ev as unknown as RunnerEvent)) accepted++;
    }
    return reply.code(202).send({ accepted });
  });

  // ---- Slack Events API
  app.post("/slack/events", async (req, reply) => {
    const ok = verifySlackSignature({
      signingSecret: config.SLACK_SIGNING_SECRET,
      timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
      signature: req.headers["x-slack-signature"] as string | undefined,
      rawBody: req.rawBody ?? Buffer.alloc(0),
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });

    const body = req.body as SlackEnvelope;
    if (body.type === "url_verification") return reply.send({ challenge: body.challenge });
    if (body.type !== "event_callback") return reply.send({ ok: true });

    const ev = body.event;
    const isMention = ev.type === "app_mention";
    const isHumanMessage = ev.type === "message" && !ev.bot_id && !ev.subtype;
    if (!isMention && !isHumanMessage) return reply.send({ ok: true });

    const employee = employees.get(config.DEFAULT_EMPLOYEE_ID);
    if (!employee) return reply.code(500).send({ error: "default employee not configured" });

    const threadTs = ev.thread_ts ?? ev.ts;
    const threadRef = `${ev.channel}:${threadTs}`;
    const conversationId = await ledger.upsertConversation(employee.id, "slack", threadRef);
    const taskId = `slack:${body.team_id}:${ev.channel}:${ev.ts}`; // one task per triggering message
    const prompt = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    const res = await orchestrator.startTask(taskId, {
      employeeId: employee.id,
      roleId: employee.defaultRole,
      prompt,
      source: { channel: "slack", conversationId, threadRef },
    });
    if (!res.started && (res.status === "queued" || res.status === "running")) {
      // Same message re-delivered (Slack retry) → tell the thread, don't double-run.
      void slack.postMessage({ channel: ev.channel, thread_ts: threadTs, text: "Already working on that." }).catch((e) => app.log.warn(e));
    }
    return reply.send({ ok: true });
  });

  // ---- ClickUp webhooks (taskCommentPosted with trigger word, taskAssigneeUpdated to the bot)
  app.post("/clickup/webhook", async (req, reply) => {
    const ok = verifyClickUpSignature({
      secret: config.CLICKUP_WEBHOOK_SECRET,
      signature: req.headers["x-signature"] as string | undefined,
      rawBody: req.rawBody ?? Buffer.alloc(0),
    });
    if (!ok) return reply.code(401).send({ error: "bad signature" });

    const employee = employees.get(config.DEFAULT_EMPLOYEE_ID);
    if (!employee) return reply.code(500).send({ error: "default employee not configured" });
    const trigger = clickUpTrigger(req.body as ClickUpWebhook, {
      employeeId: employee.id,
      ...(config.CLICKUP_TRIGGER_WORD ? { triggerWord: config.CLICKUP_TRIGGER_WORD } : {}),
      ...(config.CLICKUP_BOT_USER_ID ? { botUserId: config.CLICKUP_BOT_USER_ID } : {}),
    });
    if (!trigger) return reply.send({ ok: true, ignored: true });

    const awaiting = await ledger.findAwaitingInThread("clickup", trigger.clickupTaskId);
    if (awaiting) {
      await ledger.answerTask(awaiting.id, trigger.prompt);
      return reply.send({ ok: true, routedTo: awaiting.id });
    }

    const conversationId = await ledger.upsertConversation(employee.id, "clickup", trigger.clickupTaskId);
    const res = await orchestrator.startTask(trigger.taskId, {
      employeeId: employee.id,
      roleId: employee.defaultRole,
      prompt: trigger.prompt,
      source: { channel: "clickup", conversationId, threadRef: trigger.clickupTaskId, messageRef: trigger.taskId.split(":").pop()! },
    });
    return reply.send({ ok: true, taskId: trigger.taskId, ...res });
  });

  // ---- ClickUp Chat Automation ("Message is posted" → "Call webhook" with header X-Bot-Secret)
  app.post<{ Querystring: Record<string, string | undefined> }>("/clickup/chat", async (req, reply) => {
    // ClickUp's automation UI offers both custom headers and URL parameters; people use either
    // (observed: `?X-Bot-Secret=<value>.` with a stray period). Accept both, trim trailing punctuation.
    const raw = (req.headers["x-bot-secret"] as string | undefined) ?? req.query["X-Bot-Secret"] ?? req.query["x-bot-secret"] ?? "";
    const secret = raw.trim().replace(/[.,;\s]+$/, "");
    if (!config.CLICKUP_CHAT_SECRET || secret !== config.CLICKUP_CHAT_SECRET) return reply.code(401).send({ error: "bad secret" });
    // Payload schema is undocumented: always log the raw shape so we can tighten the parser.
    app.log.info({ clickupChatPayload: req.body }, "clickup chat webhook");

    const employee = employees.get(config.DEFAULT_EMPLOYEE_ID);
    if (!employee) return reply.code(500).send({ error: "default employee not configured" });
    const trigger = chatTrigger(req.body, config.CLICKUP_BOT_USER_ID ? { botUserId: config.CLICKUP_BOT_USER_ID } : {});
    if (!trigger) return reply.send({ ok: true, ignored: true });

    const awaiting = await ledger.findAwaitingInThread("clickup-chat", trigger.channelId);
    if (awaiting) {
      await ledger.answerTask(awaiting.id, trigger.text);
      return reply.send({ ok: true, routedTo: awaiting.id });
    }

    const conversationId = await ledger.upsertConversation(employee.id, "clickup-chat", trigger.channelId);
    const res = await orchestrator.startTask(trigger.taskId, {
      employeeId: employee.id,
      roleId: employee.defaultRole,
      prompt: trigger.text,
      source: { channel: "clickup-chat", conversationId, threadRef: trigger.channelId, messageRef: trigger.messageId },
    });
    return reply.send({ ok: true, taskId: trigger.taskId, ...res });
  });

  return app;
}

interface SlackEnvelope {
  type: string;
  challenge?: string;
  team_id: string;
  event: {
    type: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  };
}
