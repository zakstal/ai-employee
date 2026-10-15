import type { Backlog, Employee, TaskInput } from "@ai-employee/core";
import type { Config } from "../config.js";
import type { Ledger } from "../db/ledger.js";
import type { ClickUpClient } from "../clickup/client.js";

/**
 * Flow guards, all enforced server-side so a model cannot talk its way past them:
 * dispatch is refused (409 "guard: ...") when the backlog is disabled, halted, at its concurrency, over its daily
 * task or cost budget, or the item used up its attempts; and a run of consecutive failures halts the backlog.
 */
export interface GuardDeps {
  ledger: Ledger;
  config: Config;
  clickup: ClickUpClient;
}

/** Start of the current day in `tz`, and its date string. ponytail: off by up to an hour on a DST-change day. */
export function dayStart(tz: string, now: Date): { start: Date; day: string } {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const startLocal = new Date(local);
  startLocal.setHours(0, 0, 0, 0);
  return { start: new Date(now.getTime() - (local.getTime() - startLocal.getTime())), day };
}

async function alert(d: GuardDeps, text: string): Promise<void> {
  if (!d.config.ALERT_CHANNEL_ID) return;
  try {
    await d.clickup.postChannelMessage(d.config.CLICKUP_TEAM_ID, d.config.ALERT_CHANNEL_ID, text);
  } catch (e) {
    console.error("failed to post backlog alert", e);
  }
}

/** A `guard: ...` message when a dispatch must be refused, else undefined. ponytail: check-then-start is not atomic; one manager run dispatches sequentially. */
export async function checkDispatchGuards(d: GuardDeps, employee: Employee, backlogId: string, item?: string, now = new Date()): Promise<string | undefined> {
  const b: Backlog | undefined = employee.backlogs?.[backlogId];
  if (!b?.enabled) return "guard: disabled";
  const halt = await d.ledger.getBacklogHalt(employee.id, backlogId);
  if (halt) return `guard: halted (${halt.reason})`;
  const active = await d.ledger.countActiveByBacklog(employee.id, backlogId);
  if (active >= b.concurrency) return `guard: concurrency (${active}/${b.concurrency})`;
  if (item) {
    const attempts = (await d.ledger.tasksByBacklog(employee.id, backlogId)).filter((t) => t.item === item && !["queued", "running", "awaiting_input"].includes(t.status)).length;
    if (attempts >= b.guards.maxAttemptsPerItem) return `guard: item ${item} used its ${b.guards.maxAttemptsPerItem} attempts`;
  }
  const { start, day } = dayStart(d.config.DEFAULT_TZ, now);
  const used = await d.ledger.backlogUsageSince(employee.id, backlogId, start);
  const over =
    b.guards.maxTasksPerDay !== undefined && used.tasks >= b.guards.maxTasksPerDay
      ? `daily budget: ${used.tasks}/${b.guards.maxTasksPerDay} tasks`
      : b.guards.maxCostUsdPerDay !== undefined && used.costUsd >= b.guards.maxCostUsdPerDay
        ? `daily budget: $${used.costUsd.toFixed(2)} of $${b.guards.maxCostUsdPerDay}`
        : undefined;
  if (over) {
    if (await d.ledger.markBudgetAlerted(employee.id, backlogId, day)) await alert(d, `🤖 ⚠️ backlog ${backlogId}: ${over}; dispatch stops until tomorrow`);
    return `guard: ${over}`;
  }
  return undefined;
}

/** Called when a task ends. Halts the backlog after N consecutive failed/cancelled tasks (a done task resets the streak). */
export async function afterBacklogTask(d: GuardDeps, employees: Map<string, Employee>, input: TaskInput): Promise<void> {
  const id = input.source.backlogId;
  const b = id ? employees.get(input.employeeId)?.backlogs?.[id] : undefined;
  if (!id || !b) return;
  const n = b.guards.stopAfterConsecutiveFailures;
  const last = await d.ledger.lastFinishedByBacklog(input.employeeId, id, n);
  if (last.length < n || last.some((t) => t.status === "done")) return;
  const reason = `${n} consecutive failures: ${last.map((t) => t.id).join(", ")}`;
  if (await d.ledger.haltBacklog(input.employeeId, id, reason)) await alert(d, `🤖 ⚠️ backlog ${id} halted after ${reason}`);
}

export interface BacklogOverview {
  employee: string;
  id: string;
  enabled: boolean;
  halted: boolean;
  haltedReason: string | null;
  running: number;
  concurrency: number;
  today: { tasks: number; costUsd: number };
  limits: { maxTasksPerDay: number | null; maxCostUsdPerDay: number | null; maxAttemptsPerItem: number; stopAfterConsecutiveFailures: number };
}

/** Ledger-only view of every configured backlog (no source reads): for /runtime, /status and the manager's prompt. */
export async function backlogOverview(d: Pick<GuardDeps, "ledger" | "config">, employee: Employee, now = new Date()): Promise<BacklogOverview[]> {
  const { start } = dayStart(d.config.DEFAULT_TZ, now);
  return Promise.all(
    Object.entries(employee.backlogs ?? {}).map(async ([id, b]) => {
      const [running, today, halt] = await Promise.all([d.ledger.countActiveByBacklog(employee.id, id), d.ledger.backlogUsageSince(employee.id, id, start), d.ledger.getBacklogHalt(employee.id, id)]);
      return {
        employee: employee.id, id, enabled: b.enabled, halted: !!halt, haltedReason: halt?.reason ?? null, running, concurrency: b.concurrency, today,
        limits: { maxTasksPerDay: b.guards.maxTasksPerDay ?? null, maxCostUsdPerDay: b.guards.maxCostUsdPerDay ?? null, maxAttemptsPerItem: b.guards.maxAttemptsPerItem, stopAfterConsecutiveFailures: b.guards.stopAfterConsecutiveFailures },
      };
    }),
  );
}
