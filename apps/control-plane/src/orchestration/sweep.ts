import type { ResultEvent, RunExit, SandboxRuntime, TaskInput } from "@ai-employee/core";
import type { Ledger, TaskRow } from "../db/ledger.js";
import { deps } from "./deps.js";
import { collectResult, finalize, postResult } from "./steps.js";

/**
 * Safety net for a task whose workflow was lost (a deploy or crash mid-run): its sandbox has ended but nobody
 * will ever write the result, so it would stay "running" forever. Anything the runner managed to report is
 * honoured (result delivered, status from it); otherwise the task fails visibly.
 */
export interface SweepDeps {
  ledger: Ledger;
  runtimes: Record<string, SandboxRuntime>;
  /** How long a sandbox may be over before its task is declared lost. Must exceed the runner's ~5 min report retry window. */
  graceMs: number;
  now: () => number;
  /** Stop the task's (stale) workflow. Best effort. */
  cancel: (taskId: string) => Promise<void>;
  /** The sandbox's result event, if the runner got one through. */
  collect: (taskId: string) => Promise<ResultEvent | undefined>;
  /** Deliver + record the outcome, as the workflow's last two steps would have. */
  finish: (task: TaskRow, exit: RunExit, result: ResultEvent | undefined) => Promise<void>;
  log?: (msg: string) => void;
}

/** First time each ended sandbox was seen without a platform end time (e.g. `lost`). In memory: a restart just restarts the grace. */
const firstSeenEnded = new Map<string, number>();

const toInput = (t: TaskRow): TaskInput => ({ employeeId: t.employee_id, roleId: t.role_id, prompt: t.prompt, source: t.source });

/** Returns the ids of tasks it closed. Never throws: one broken sandbox lookup must not block the others. */
export async function sweepEndedSandboxes(d: SweepDeps): Promise<string[]> {
  const log = d.log ?? ((m: string) => console.warn(m));
  const swept: string[] = [];
  const active = await d.ledger.activeTasks();
  const live = new Set(active.map((t) => t.id));
  for (const id of firstSeenEnded.keys()) if (!live.has(id)) firstSeenEnded.delete(id);

  for (const task of active) {
    if (!task.run_handle || (task.status !== "running" && task.status !== "awaiting_input")) continue;
    const rt = d.runtimes[task.run_handle.adapter];
    if (!rt?.status) continue; // adapter cannot report: nothing to sweep against
    try {
      const st = await rt.status(task.run_handle);
      if (st.state === "running") {
        firstSeenEnded.delete(task.id);
        continue;
      }
      const now = d.now();
      const endedAt = st.endedAt ? Date.parse(st.endedAt) : NaN;
      const since = Number.isFinite(endedAt) ? endedAt : (firstSeenEnded.get(task.id) ?? now);
      if (!Number.isFinite(endedAt) && !firstSeenEnded.has(task.id)) firstSeenEnded.set(task.id, now);
      if (now - since < d.graceMs) continue;

      const fresh = await d.ledger.getTask(task.id);
      if (!fresh || (fresh.status !== "running" && fresh.status !== "awaiting_input")) continue; // finished while we looked
      const result = await d.collect(task.id);
      const exit: RunExit = { code: st.exitCode ?? 1, reason: st.reason ?? (st.state === "lost" ? "lost" : "sandbox-ended") };
      log(`sweep: task ${task.id} sandbox ${st.state} since ${new Date(since).toISOString()} with no final result recorded; closing it`);
      await d.cancel(task.id).catch((e) => log(`sweep: cancel ${task.id}: ${(e as Error).message}`));
      await d.finish(fresh, exit, result);
      firstSeenEnded.delete(task.id);
      swept.push(task.id);
    } catch (e) {
      log(`sweep: ${task.id}: ${(e as Error).message}`);
    }
  }
  return swept;
}

/** The sweep wired to the running control plane; `graceMs` 0 (SANDBOX_SWEEP_GRACE_MIN=0) disables it. */
export async function sweepWithDeps(): Promise<string[]> {
  const { config, ledger, runtimes, orchestrator } = deps();
  if (config.SANDBOX_SWEEP_GRACE_MIN <= 0) return [];
  return sweepEndedSandboxes({
    ledger,
    runtimes,
    graceMs: config.SANDBOX_SWEEP_GRACE_MIN * 60_000,
    now: Date.now,
    cancel: (id) => orchestrator.cancel(id),
    collect: collectResult,
    finish: async (task, exit, result) => {
      await postResult(task.id, toInput(task), exit, result); // no placeholder to edit any more: posts a fresh message
      await finalize(task.id, exit, result, toInput(task));
    },
  }).catch((e) => {
    console.error("sweep failed", e); // a database blip must not fail the schedule tick that runs it
    return [];
  });
}
