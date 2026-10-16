import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { z } from "zod";
import type { LimitHit } from "@ai-employee/core";

/** Recoveries (failover or wait) one task may use before a limit message simply ends it. */
export const MAX_LIMIT_RECOVERIES = 3;
/** Extra sleep after a reset time, so the window has really reopened. */
export const WAIT_SLACK_MS = 60_000;
export const HEARTBEAT_MS = 120_000;

export const RESUME_PROMPT =
  "You hit a usage limit; the employee switched account (or waited). Continue where you left off; any build that failed during the outage must be rerun.";

const Decision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("failover"), account: z.string(), token: z.string().min(1) }),
  z.object({ action: z.literal("wait"), waitUntil: z.string(), account: z.string().optional(), token: z.string().min(1).optional() }),
  z.object({ action: z.literal("exit"), reason: z.string() }),
]);

/**
 * Runs every executable in /etc/ai-employee/token-refresh.d/ (override: TOKEN_REFRESH_D_DIR) with the new token in
 * CLAUDE_CODE_OAUTH_TOKEN, so an image can refresh files other processes read (e.g. a Fabro agent's ~/.fabro/claude.env).
 * Never fatal; a note per hook, and notes never contain the token.
 */
export function runTokenRefreshHooks(env: NodeJS.ProcessEnv, token: string, account: string | undefined, run = spawnSync): string[] {
  const dir = env.TOKEN_REFRESH_D_DIR ?? "/etc/ai-employee/token-refresh.d";
  const notes: string[] = [];
  if (!existsSync(dir)) return notes;
  const hookEnv = { ...env, CLAUDE_CODE_OAUTH_TOKEN: token, ...(account ? { CLAUDE_ACCOUNT: account } : {}) };
  for (const name of readdirSync(dir).sort()) {
    const file = `${dir}/${name}`;
    if (!statSync(file).isFile() || !(statSync(file).mode & 0o111)) continue;
    const r = run(file, [], { env: hookEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000 });
    const out = String(r.stdout ?? "").trim().split("\n").pop();
    notes.push(r.status === 0 ? `token-refresh.d/${name}: ${out || "ok"}` : `token-refresh.d/${name}: failed: ${String(r.stderr ?? "").trim().slice(0, 300) || r.error?.message || "unknown"}`);
  }
  return notes.map((n) => n.split(token).join("***"));
}

export interface RecoveryDeps {
  /** The runner's own environment: CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_ACCOUNT are rewritten on a switch. */
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms after which the sandbox is killed; a wait that would outlast it is not started. */
  deadlineMs: number;
  /** A `limit_hit` event for the control plane's task record. */
  reportLimit: (ev: { account?: string; resetsAt?: string; action: "failover" | "wait" | "exit"; toAccount?: string; waitUntil?: string }) => void;
  heartbeat: (note: string) => void;
  log: (line: string) => void;
  runHooks?: (token: string, account: string | undefined) => string[];
}

/**
 * The Claude account hit its limit. Ask the control plane what to do and do it. Resolves "resume" when the next turn
 * should run (new token already in `env`, hooks run, any wait already slept) and "exit" when the task should end as it is.
 */
export async function recoverFromLimit(d: RecoveryDeps, hit: LimitHit): Promise<"resume" | "exit"> {
  const { env } = d;
  const account = env.CLAUDE_ACCOUNT || undefined;
  const resetsAt = hit.resetsAt?.toISOString();
  const base = { ...(account ? { account } : {}), ...(resetsAt ? { resetsAt } : {}) };
  let decision: z.infer<typeof Decision>;
  try {
    const { CONTROL_PLANE_URL, RUN_TOKEN, TASK_ID } = env;
    if (!CONTROL_PLANE_URL || !RUN_TOKEN || !TASK_ID) throw new Error("CONTROL_PLANE_URL, RUN_TOKEN and TASK_ID are required");
    const res = await d.fetch(`${CONTROL_PLANE_URL}/agents/self/limit`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}`, "x-task-id": TASK_ID, "content-type": "application/json" },
      body: JSON.stringify({ ...base, window: hit.window }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    decision = Decision.parse(await res.json());
  } catch (e) {
    d.log(`limit: control plane gave no decision (${e instanceof Error ? e.message : String(e)}); ending the task`);
    d.reportLimit({ ...base, action: "exit" });
    return "exit";
  }

  const adopt = (token: string, to: string | undefined): void => {
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    if (to) env.CLAUDE_ACCOUNT = to;
    for (const note of (d.runHooks ?? ((t, a) => runTokenRefreshHooks(env, t, a)))(token, to)) d.log(note);
  };

  if (decision.action === "exit") {
    d.log(`limit: ending the task (${decision.reason})`);
    d.reportLimit({ ...base, action: "exit" });
    return "exit";
  }
  if (decision.action === "failover") {
    d.reportLimit({ ...base, action: "failover", toAccount: decision.account });
    adopt(decision.token, decision.account);
    return "resume";
  }
  const until = Date.parse(decision.waitUntil);
  const wakeAt = (Number.isNaN(until) ? d.now() + HEARTBEAT_MS : until) + WAIT_SLACK_MS;
  if (wakeAt >= d.deadlineMs) {
    d.log(`limit: reset at ${decision.waitUntil} is past this task's time limit; ending the task`);
    d.reportLimit({ ...base, action: "exit", waitUntil: decision.waitUntil });
    return "exit";
  }
  d.reportLimit({ ...base, action: "wait", waitUntil: decision.waitUntil, ...(decision.account ? { toAccount: decision.account } : {}) });
  d.log(`limit: waiting until ${new Date(wakeAt).toISOString()}`);
  while (d.now() < wakeAt) {
    d.heartbeat(`waiting for Claude usage limit to reset (${new Date(wakeAt).toISOString()})`);
    await d.sleep(Math.min(HEARTBEAT_MS, wakeAt - d.now()));
  }
  if (decision.token) adopt(decision.token, decision.account);
  return "resume";
}
