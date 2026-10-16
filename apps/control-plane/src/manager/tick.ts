import type { TaskInput } from "@ai-employee/core";
import { deps } from "../orchestration/deps.js";
import { alertSource } from "../alerts.js";

/**
 * The manager: woken when backlog work finishes, not on a timer.
 *
 * A task carrying `source.managedBy` is backlog work. When one reaches a terminal state the ledger records
 * a pending wake; this claims it (at most once per debounce window) and hands the manager a task. The
 * manager's own run never carries `managedBy`, and child tasks are ignored, so it cannot wake itself.
 */

/** Was this task backlog work whose completion the manager should react to? */
export function shouldWake(input: TaskInput): boolean {
  const { config } = deps();
  if (!config.MANAGER_ROLE) return false;
  if (!input.source.managedBy) return false;
  // A stage finishing is the foreman's business, not the manager's; a child the manager spawned for a backlog item is the exception.
  if (input.source.channel === "child" && !input.source.backlogId) return false;
  if (input.roleId === config.MANAGER_ROLE) return false; // never react to itself
  return true;
}

export async function requestWake(employeeId: string, taskId: string, status: string): Promise<void> {
  await deps().ledger.requestManagerWake(employeeId, `${taskId} ${status}`);
}

/** Returns the task to start, or undefined when no wake is due. */
export async function claim(employeeId: string, now: Date): Promise<{ taskId: string; input: TaskInput } | undefined> {
  const { config, ledger } = deps();
  if (!config.MANAGER_ROLE) return undefined;
  await ledger.ensureManagerState(employeeId);
  const reason = await ledger.claimManagerWake(employeeId, now, config.MANAGER_DEBOUNCE_SEC, config.MANAGER_HEARTBEAT_MIN);
  if (reason === null) return undefined;
  const heartbeat = reason === "HEARTBEAT";
  const stamp = now.toISOString().slice(0, 16); // minute resolution == dedup key
  return {
    taskId: `manager:${employeeId}:${stamp}`,
    input: {
      employeeId,
      roleId: config.MANAGER_ROLE,
      prompt: heartbeat
        ? "Routine check — nothing has finished for a while. Confirm the backlog is actually moving: is " +
          "anything dispatched but stuck, did something fail without being noticed, is anything now " +
          "unblocked that nobody started? If everything is in order and there is nothing to dispatch, " +
          "reply with exactly IDLE and stop; it costs nothing and is not posted."
        : "Backlog work finished, so you are being woken to decide what happens next.\n\n" +
          `What completed since your last run: ${reason}\n\n` +
          "Follow your standing procedure: establish what is actually done from the branches and the task " +
          "records, update the backlog, dispatch whatever is now unblocked, and report only what a human needs.",
      source: alertSource(config),
    },
  };
}
