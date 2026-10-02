import type { TaskInput } from "@ai-employee/core";
import { deps } from "../orchestration/deps.js";
import type { ScheduleRow } from "../db/ledger.js";
import { nextFire } from "./cron.js";

/** Engine-free helpers shared by the DBOS tick workflow and by tests. */

export async function listDue(now: Date): Promise<ScheduleRow[]> {
  return deps().ledger.dueSchedules(now);
}

export function taskFor(schedule: ScheduleRow): { taskId: string; input: TaskInput } {
  return {
    taskId: `cron:${schedule.id}:${schedule.next_fire_at.toISOString()}`,
    input: {
      employeeId: schedule.employee_id,
      roleId: schedule.role_id,
      prompt: schedule.prompt,
      // quiet: machine-triggered — no placeholder/spinner, just the finished content in the channel.
      source: { channel: schedule.deliver_to.channel as "clickup" | "clickup-chat", threadRef: schedule.deliver_to.threadRef, quiet: true },
    },
  };
}

export async function markFired(schedule: ScheduleRow, now: Date): Promise<void> {
  await deps().ledger.markFired(schedule.id, now, nextFire(schedule.cron, schedule.timezone, now));
}

/**
 * Convenience for tests / non-DBOS callers: fire everything due via the Orchestrator.
 * NOT used by the DBOS tick — DBOS forbids starting a workflow from inside a step, so the
 * tick workflow body starts child workflows itself (see orchestration/schedule-workflow.ts).
 */
export async function fireDueSchedules(now: Date): Promise<string[]> {
  const { orchestrator } = deps();
  const started: string[] = [];
  for (const schedule of await listDue(now)) {
    const { taskId, input } = taskFor(schedule);
    await orchestrator.startTask(taskId, input);
    started.push(taskId);
    await markFired(schedule, now);
  }
  return started;
}
