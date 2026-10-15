import { resolveRole, roleGrants, type Employee, type Role, type ResultEvent, type RunExit, type RunHandle, type RunSpec, type StartedEvent, type TaskInput } from "@ai-employee/core";
import type { Config } from "../config.js";
import { deps } from "./deps.js";
import { requestWake, shouldWake } from "../manager/tick.js";
import { BOT_MARKER } from "../clickup/chat.js";
import { grantEnvNames, grantPurposes, resolveGrantEnv } from "../credentials/index.js";

/**
 * Steps: plain async functions with side effects. Engine-free. Each must be
 * safe to re-run if the process dies before the engine records completion.
 */

export async function buildRunSpec(taskId: string, input: TaskInput): Promise<RunSpec> {
  const { config, ledger, employees } = deps();
  const employee = employees.get(input.employeeId);
  if (!employee) throw new Error(`unknown employee ${input.employeeId}`);
  const role = resolveRole(employee, input.roleId);

  const runToken = await ledger.issueRunToken(taskId, role.timeoutSec + 600);
  // One Claude Code session per conversation: the runner keeps a stable workspace + `--resume`s the
  // last session, so the model has real state (tool results included) instead of a pasted transcript.
  const conversationId = input.source.conversationId;
  const sessionId = conversationId ? await ledger.getConversationSession(conversationId) : null;
  const env: Record<string, string> = {
    TASK_ID: taskId,
    GIT_AUTHOR_NAME: employee.name,
    TASK_PROMPT: await enrichPrompt(input, sessionId !== null),
    SYSTEM_PROMPT: `${role.systemPrompt.trimEnd()}\n\n${environmentFooter(role, employee)}`,
    ALLOWED_TOOLS: role.allowedTools.join(","),
    DISALLOWED_TOOLS: role.disallowedTools.join(","),
    MAX_TURNS: String(role.maxTurns),
    MCP_CONFIG: "", // filled below once credentials are known
    EVENT_SINK_URL: `${config.PUBLIC_BASE_URL}/runs/${taskId}/events`,
    RUN_TOKEN: runToken,
    ...(role.model ? { MODEL: role.model } : {}),
    ...(role.repos.length ? { REPOS: JSON.stringify(role.repos) } : {}),
    ...(conversationId ? { WORKSPACE_KEY: `conv-${conversationId}` } : {}),
    ...(sessionId ? { RESUME_SESSION_ID: sessionId } : {}),
  };
  // Built-in tools the agent may call back into the control plane with (per-run token, scoped to this task).
  const builtinServers: Record<string, unknown> = {};
  if (role.capabilities.some((c) => c === "schedules" || c === "agents" || c === "monitors" || c === "backlog")) {
    builtinServers.ai_employee = {
      command: "ai-employee-tools",
      env: { CONTROL_PLANE_URL: config.PUBLIC_BASE_URL, RUN_TOKEN: runToken, TASK_ID: taskId, DEFAULT_TZ: config.DEFAULT_TZ },
    };
    if (!role.allowedTools.includes("mcp__ai_employee__*")) env.ALLOWED_TOOLS = [...role.allowedTools, "mcp__ai_employee__*"].join(",");
  }
  // Credential values are NOT part of this step's output (DBOS records it): launchSandbox resolves them. Only their
  // names are needed here, so MCP servers whose ${VAR} placeholders a grant provides are kept.
  const credNames = grantEnvNames(employee, role, config);
  env.MCP_CONFIG = JSON.stringify({ mcpServers: { ...resolvableMcpServers(role.mcpServers, { ...env, ...Object.fromEntries(credNames.map((n) => [n, "1"])) }), ...builtinServers } });
  return {
    runId: taskId,
    ...resolveImage(role, config),
    env,
    cpu: role.cpu,
    memoryMb: role.memoryMb,
    timeoutSec: role.timeoutSec,
    employeeId: employee.id,
  };
}

/**
 * Image (and Cloud Run Job) for a role. `imageRef` names a RUNNER_IMAGES entry and the job `${prefix}-${ref}`;
 * without it the legacy `image` / RUNNER_IMAGE applies and the job name is derived from the image.
 */
export function resolveImage(role: Role, config: Config): { image: string; jobName?: string } {
  if (!role.imageRef) return { image: role.image ?? config.RUNNER_IMAGE };
  return { image: config.RUNNER_IMAGES[role.imageRef] ?? config.RUNNER_IMAGE, jobName: `${config.CLOUDRUN_JOB_PREFIX}-${role.imageRef}` };
}

/** Runtime a role runs on: its own if this deployment registered it (k8s is the default tier), else the deployment default. */
export function runtimeFor(role: Role | undefined, defaultRuntime: string, registered: string[]): string {
  if (role?.runtime && role.runtime !== "k8s" && registered.includes(role.runtime)) return role.runtime;
  return defaultRuntime;
}

/**
 * Deterministic statement of what this run can actually use, derived from the role's grants and
 * tool allowlist. Models otherwise infer capabilities from earlier chat turns or from tool NAMES
 * ("no Azure tool") — az/gh/git are shell commands behind Bash, not named tools.
 */
export function environmentFooter(role: Role, employee?: Employee): string {
  const lines: string[] = ["## Your environment (authoritative — do not infer capabilities from earlier messages)"];
  const bash = role.allowedTools.filter((t) => t.startsWith("Bash("));
  const purposes = grantPurposes(employee, role);
  if (purposes.has("azure")) {
    lines.push("- Azure CLI: `az` is installed and ALREADY LOGGED IN. Run it through Bash (e.g. `az group list`). Read-only: show/list/get/query/monitor work; mutating verbs are refused by a guard.");
  }
  if (purposes.has("github")) lines.push("- GitHub: `gh` and `git` are authenticated. Branch, commit, `gh pr create`. Never push to main, never merge.");
  if (purposes.has("clickup")) lines.push("- ClickUp: MCP tools `mcp__clickup__*` (search/get tasks, comments). Replies you write are posted to the originating task or channel automatically.");
  if (role.repos.length) lines.push(`- Repos cloned under /workspace: ${role.repos.map((r) => r.url.split("/").pop()?.replace(/\.git$/, "")).join(", ")}.`);
  if (role.capabilities.includes("agents")) lines.push("- Delegation: `spawn_agent`, `start_workstream`, `wait_for`, `agent_events` (peek at a child's progress), `cancel_agent`, `list_agents`, `ask_human` (MCP server `ai_employee`).");
  if (role.capabilities.includes("schedules")) lines.push("- Schedules: `create_schedule`, `list_schedules`, `delete_schedule`.");
  if (bash.some((b) => b.startsWith("Bash(psql") || b.startsWith("Bash(pg-scratch"))) {
    lines.push('- Postgres: `eval "$(pg-scratch)"` starts a throwaway server in your workspace and exports DATABASE_URL. Use it for anything needing a real database; it dies with this run.');
  }
  if (role.capabilities.includes("backlog")) lines.push("- Backlog: `list_tasks` shows every recent task for this employee, not just your own children.");
  if (role.capabilities.includes("monitors")) lines.push("- Monitors (background sweeps, default OFF): `list_monitors`, `enable_monitor`, `disable_monitor`. Turn one on/off when the user asks.");
  if (bash.length) lines.push(`- Shell commands allowed: ${bash.map((b) => b.slice(5, -1)).join(", ")}. Anything else via Bash is denied.`);
  lines.push("- If you are unsure whether something works, run it once and report the actual result. Never claim a tool is unavailable without trying.");
  return lines.join("\n");
}

/**
 * Drop MCP servers whose `env` references `${VAR}` placeholders that the run env
 * does not provide. Otherwise the server crashes at start and Claude Code waits
 * out MCP_TIMEOUT (30s) on every task.
 */
export function resolvableMcpServers(servers: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(servers)) {
    const refs = JSON.stringify(def).match(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g) ?? [];
    const missing = refs.map((r) => r.slice(2).replace(/[:}].*$/, "")).filter((v) => !env[v] && !process.env[v]);
    if (missing.length === 0) out[name] = def;
  }
  return out;
}

/** Channel-specific context the agent needs but the webhook did not carry. */
async function enrichPrompt(input: TaskInput, resuming = false): Promise<string> {
  if (input.source.channel === "clickup" && input.source.threadRef) {
    const t = await deps().clickup.getTask(input.source.threadRef);
    const header = [`ClickUp task ${t.id}: ${t.name}`, t.url ? `URL: ${t.url}` : "", t.status?.status ? `Status: ${t.status.status}` : "", t.description ? `\nDescription:\n${t.description}` : ""]
      .filter(Boolean)
      .join("\n");
    return `${header}\n\nRequest:\n${input.prompt}`;
  }
  if (input.source.channel === "clickup-chat" && input.source.threadRef) {
    if (resuming) return input.prompt; // the resumed session already holds the conversation
    const { config, clickup } = deps();
    const msgs = await clickup.getChannelMessages(config.CLICKUP_TEAM_ID, input.source.threadRef, config.CLICKUP_CHAT_HISTORY).catch(() => []);
    const history = msgs
      .slice()
      .reverse()
      .filter((m) => m.text.trim() && m.text.trim() !== input.prompt.trim() && m.text.trim() !== ACK_TEXT.trim())
      .map((m) => `${m.text.startsWith(BOT_MARKER.trim()) ? "you" : `user${m.userId ? ` ${m.userId}` : ""}`}: ${m.text.replace(BOT_MARKER, "")}`)
      .join("\n");
    const note = "Note: earlier replies marked `you:` came from previous sessions whose tools and access may differ from this one. Never infer your current capabilities from them; check by running a command.";
    return `${history ? `Conversation so far in this ClickUp chat (oldest first):\n${history}\n\n${note}\n\n` : ""}Latest message from the user:\n${input.prompt}`;
  }
  return input.prompt;
}

export interface AckRef {
  kind: "chat" | "comment";
  id: string;
}

export const ACK_TEXT = `${BOT_MARKER}…`;

/**
 * Immediate feedback in the channel: 👀 on the triggering message plus a placeholder
 * reply that postResult edits into the final answer. Best-effort: failures here must
 * never fail the task.
 */
export async function acknowledge(input: TaskInput): Promise<AckRef | undefined> {
  if (input.source.channel === "child") return undefined; // parent reads the result via GET /agents/:id, no channel to post to
  if (input.source.quiet) return undefined; // monitors: nothing to show until there is something to say
  const { config, clickup } = deps();
  try {
    if (input.source.channel === "clickup-chat" && input.source.threadRef) {
      const id = await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, input.source.threadRef, ACK_TEXT);
      return id ? { kind: "chat", id } : undefined;
    }
    if (input.source.channel === "clickup" && input.source.threadRef) {
      const id = await clickup.postComment(input.source.threadRef, ACK_TEXT);
      return id ? { kind: "comment", id } : undefined;
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

export async function markRunning(taskId: string, handle: RunHandle): Promise<void> {
  await deps().ledger.setStatus(taskId, "running", { runHandle: handle });
}

/**
 * Resolves the role's credentials and starts the sandbox with them. Resolution happens here, not in buildRunSpec,
 * because DBOS persists every step's return value: this step returns only a RunHandle, so no credential value is
 * stored at rest. A rerun after a crash re-resolves (right for per-task minted tokens).
 */
export async function launchSandbox(spec: RunSpec, runtimeName: string, input: TaskInput): Promise<RunHandle> {
  const { config, employees, runtimes, secrets } = deps();
  const rt = runtimes[runtimeName];
  if (!rt) throw new Error(`no sandbox runtime registered as ${runtimeName}`);
  const employee = employees.get(input.employeeId);
  if (!employee) throw new Error(`unknown employee ${input.employeeId}`);
  const role = resolveRole(employee, input.roleId);
  const grantEnv = await resolveGrantEnv({ employee, role, taskId: spec.runId, config, secrets, fetch, now: () => new Date() }, roleGrants(role));
  return rt.start({ ...spec, env: { ...spec.env, ...grantEnv } });
}

const VERBS = [
  "Thinking", "Pondering", "Brewing", "Cogitating", "Noodling", "Percolating", "Ruminating", "Marinating",
  "Simmering", "Wrangling", "Conjuring", "Scheming", "Tinkering", "Spelunking", "Mulling", "Musing",
  "Puzzling", "Sleuthing", "Fiddling", "Untangling", "Rummaging", "Deliberating", "Concocting", "Hatching",
];
export const ACK_INTERVAL_MS = 3000;

/** What the agent is doing right now, from the newest tool_use event, e.g. "reading src/x.ts". */
async function currentActivity(taskId: string): Promise<string> {
  const events = await deps().ledger.listEvents(taskId).catch(() => []);
  const last = [...events].reverse().find((e) => e.type === "tool_use");
  if (!last || last.type !== "tool_use") return "";
  const input = (last.input ?? {}) as Record<string, unknown>;
  const target = String(input.file_path ?? input.pattern ?? input.command ?? input.query ?? input.url ?? "").split("\n")[0] ?? "";
  const verb: Record<string, string> = { Read: "reading", Edit: "editing", Write: "writing", Grep: "searching", Glob: "listing", Bash: "running", WebFetch: "fetching", WebSearch: "searching the web" };
  const v = verb[last.tool] ?? (last.tool.startsWith("mcp__clickup") ? "checking ClickUp" : `using ${last.tool}`);
  const shown = target.length > 60 ? `${target.slice(0, 57)}…` : target;
  return shown && !last.tool.startsWith("mcp__") ? `${v} \`${shown}\`` : v;
}

/** Wait for the sandbox; meanwhile refresh the placeholder every 3s with a Claude-style verb and the live activity. */
export async function waitForExit(handle: RunHandle, ack?: AckRef, taskId?: string): Promise<RunExit> {
  const { runtimes, clickup, config } = deps();
  const rt = runtimes[handle.adapter];
  if (!rt) throw new Error(`no sandbox runtime registered as ${handle.adapter}`);
  let lastVerb = "";
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    let verb = VERBS[Math.floor(Math.random() * VERBS.length)]!;
    if (verb === lastVerb) verb = VERBS[(VERBS.indexOf(verb) + 1) % VERBS.length]!;
    lastVerb = verb;
    const activity = taskId ? await currentActivity(taskId) : "";
    if (stopped) return; // don't let a late spinner frame overwrite the final answer
    const text = `${BOT_MARKER}*${verb}…*${activity ? ` ${activity}` : ""}`;
    if (ack?.kind === "chat") await clickup.updateChannelMessage(config.CLICKUP_TEAM_ID, ack.id, text).catch(() => {});
    else if (ack?.kind === "comment") await clickup.updateComment(ack.id, text).catch(() => {});
  };
  const timer = ack ? setInterval(() => void (inflight = tick()), ACK_INTERVAL_MS) : undefined;
  try {
    return await rt.wait(handle);
  } finally {
    stopped = true;
    if (timer) clearInterval(timer);
    await inflight; // a frame already past its `stopped` check finishes before postResult edits the message
  }
}

/** Runner posts `result` just before exiting; tolerate a short race. */
export async function collectResult(taskId: string): Promise<ResultEvent | undefined> {
  const { ledger } = deps();
  for (let i = 0; i < 10; i++) {
    const events = await ledger.listEvents(taskId);
    const result = events.find((e): e is ResultEvent => e.type === "result");
    if (result) return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/** Channels with no human thread watching the result: a failure here would otherwise go unnoticed. */
const ALERTABLE_CHANNELS = new Set(["cron", "child", "http"]);

/** Best-effort one-line failure alert to the ops chat channel. Never throws. */
async function alertOnFailure(taskId: string, input: TaskInput, exit: RunExit, result: ResultEvent | undefined, text: string): Promise<void> {
  const { config, clickup } = deps();
  if (!config.ALERT_CHANNEL_ID) return;
  const failed = exit.code !== 0 || result?.isError === true;
  if (!failed || !ALERTABLE_CHANNELS.has(input.source.channel)) return;
  if (input.source.channel === "child" && input.source.parentTaskId) {
    // A live parent sees this through wait_for and decides what to do; alerting too is just noise.
    const parent = await deps().ledger.getTask(input.source.parentTaskId);
    if (parent && (parent.status === "running" || parent.status === "queued" || parent.status === "awaiting_input")) return;
  }
  try {
    await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, config.ALERT_CHANNEL_ID, `🤖 ⚠️ ${input.roleId} run failed (${taskId}): ${text.slice(0, 300)}`);
  } catch (e) {
    console.error("failed to post failure alert", e);
  }
}

export async function postResult(taskId: string, input: TaskInput, exit: RunExit, result: ResultEvent | undefined, ack?: AckRef): Promise<void> {
  const text = summarize(exit, result);
  await alertOnFailure(taskId, input, exit, result, text);
  const { slack, clickup, config, ledger } = deps();
  if (input.source.channel === "child") {
    // Parent still running: it reads the result via GET /agents/:id. Parent already finished (fire-and-forget
    // escalation, e.g. monitor triage → sdlc): nobody will relay, so post to the root thread ourselves.
    const parent = input.source.parentTaskId ? await ledger.getTask(input.source.parentTaskId) : undefined;
    if (!parent || parent.status === "running" || parent.status === "queued" || parent.status === "awaiting_input") return;
    const root = await rootTask(input.source.parentTaskId!);
    const relay = `${BOT_MARKER}Follow-up from ${input.roleId} (${taskId}):\n${text}`;
    try {
      if (root.source.channel === "clickup-chat" && root.source.threadRef) await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, root.source.threadRef, relay);
      else if (root.source.channel === "clickup" && root.source.threadRef) await clickup.postComment(root.source.threadRef, relay);
    } catch {
      /* best effort */
    }
    return;
  }
  if (input.source.quiet && isNoiseVerdict(text)) return; // monitor triage judged it not worth a message
  const marked = `${BOT_MARKER}${text}`;
  if (input.source.channel === "clickup" && input.source.threadRef) {
    if (ack?.kind === "comment") await clickup.updateComment(ack.id, marked).catch(() => clickup.postComment(input.source.threadRef!, marked));
    else await clickup.postComment(input.source.threadRef, marked);
  }
  if (input.source.channel === "clickup-chat" && input.source.threadRef) {
    if (ack?.kind === "chat") await clickup.updateChannelMessage(config.CLICKUP_TEAM_ID, ack.id, marked).catch(() => clickup.postChannelMessage(config.CLICKUP_TEAM_ID, input.source.threadRef!, marked));
    else await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, input.source.threadRef, marked);
  }
  if (input.source.channel === "slack" && input.source.threadRef) {
    const [channel, threadTs] = input.source.threadRef.split(":");
    if (channel && threadTs) await slack.postMessage({ channel, text, thread_ts: threadTs });
  }
}

/**
 * "Nothing to say" verdicts from machine-triggered runs: triage answers NOISE, the manager's heartbeat
 * answers IDLE. Either way nothing is posted. The model sometimes reasons first and ends with the word,
 * so a trailing verdict counts too.
 */
export function isNoiseVerdict(text: string): boolean {
  const t = text.trim();
  return /^\**(NOISE|IDLE)\**\.?$/i.test(t) || /\n\s*\**(NOISE|IDLE)\**\.?\s*$/i.test(t);
}

async function rootTask(taskId: string) {
  const { ledger } = deps();
  let t = await ledger.getTask(taskId);
  if (!t) throw new Error(`task ${taskId} not found`);
  while (t.parent_task_id) {
    const parent = await ledger.getTask(t.parent_task_id);
    if (!parent) break;
    t = parent;
  }
  return t;
}

export function summarize(exit: RunExit, result: ResultEvent | undefined): string {
  if (result && !result.isError) return result.text;
  if (result?.isError) return `Task failed: ${result.text}`;
  if (exit.reason === "timeout") return "Task hit its time limit before finishing. Any work it pushed is on its branch; re-run with a narrower brief.";
  if (exit.code === 1) return "Task hit its turn limit before finishing (the harness stops at maxTurns). Any work it pushed is on its branch; re-run with a narrower brief or raise the role's maxTurns.";
  return `Task ended without a result (exit ${exit.code}${exit.reason ? `, ${exit.reason}` : ""}).`;
}

export async function finalize(taskId: string, exit: RunExit, result: ResultEvent | undefined, input?: TaskInput): Promise<void> {
  const ok = exit.code === 0 && result !== undefined && !result.isError;
  const { ledger } = deps();
  // Backlog work finishing is what wakes the manager; the tick picks the request up (debounced).
  if (input && shouldWake(input)) await requestWake(input.employeeId, taskId, ok ? "done" : "failed");
  // Remember the session this run used (or created) so the conversation's next message resumes it.
  const task = await ledger.getTask(taskId);
  if (task?.conversation_id) {
    const started = (await ledger.listEvents(taskId)).find((e): e is StartedEvent => e.type === "started");
    if (started?.sessionId) await ledger.setConversationSession(task.conversation_id, started.sessionId);
  }
  await ledger.setStatus(taskId, ok ? "done" : exit.reason === "cancelled" ? "cancelled" : "failed", {
    result: {
      exit,
      text: result?.text,
      costUsd: result?.costUsd,
      numTurns: result?.numTurns,
      ...(result?.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result?.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result?.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
      ...(result?.cacheCreationTokens !== undefined ? { cacheCreationTokens: result.cacheCreationTokens } : {}),
    },
  });
}
