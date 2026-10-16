import { DBOS } from "@dbos-inc/dbos-sdk";
import type { TaskInput } from "@ai-employee/core";
import { resolveRole } from "@ai-employee/core";
import { deps } from "./deps.js";
import * as s from "./steps.js";

/** Launch-time waits for a Claude account's limit window to reset before the task is failed. */
const MAX_ACCOUNT_WAITS = 20;

/**
 * The ONE workflow body. Rules (see core/orchestrator.ts): only step calls
 * and waits, no IO, no clock, no randomness, no env reads. Written so a
 * Temporal port is a line-for-line translation.
 */
async function taskWorkflowBody(taskId: string, input: TaskInput): Promise<void> {
  const ack = await DBOS.runStep(() => s.acknowledge(input), { name: "acknowledge" });
  // Before buildRunSpec: its run token has a TTL, and waiting for an account's window to reset can take hours.
  let pick = await DBOS.runStep(() => s.pickClaudeAccount(taskId, input), { name: "pickClaudeAccount" });
  for (let i = 0; pick.waitMs !== undefined && i < MAX_ACCOUNT_WAITS; i++) {
    await DBOS.sleep(pick.waitMs);
    pick = await DBOS.runStep(() => s.pickClaudeAccount(taskId, input), { name: "pickClaudeAccountAgain" });
  }
  if (pick.waitMs !== undefined || pick.error !== undefined) {
    const message = pick.error ?? "every Claude account is still at its limit";
    await DBOS.runStep(() => s.failLaunch(taskId, input, message, ack), { name: "failLaunch" });
    return;
  }
  const spec = await DBOS.runStep(() => s.buildRunSpec(taskId, input), { name: "buildRunSpec" });
  const runtimeName = await DBOS.runStep(() => pickRuntime(input), { name: "pickRuntime" });
  const handle = await DBOS.runStep(() => s.launchSandbox(spec, runtimeName, input, pick.account), { name: "launchSandbox" });
  await DBOS.runStep(() => s.markRunning(taskId, handle), { name: "markRunning" });
  const exit = await DBOS.runStep(() => s.waitForExit(handle, ack, taskId), { name: "waitForExit", retriesAllowed: false });
  const result = await DBOS.runStep(() => s.collectResult(taskId), { name: "collectResult" });
  await DBOS.runStep(() => s.postResult(taskId, input, exit, result, ack), { name: "postResult" });
  await DBOS.runStep(() => s.finalize(taskId, exit, result, input), { name: "finalize" });
}

async function pickRuntime(input: TaskInput): Promise<string> {
  // Deployment default (SANDBOX_RUNTIME) unless the role names a runtime that this deployment has registered,
  // e.g. an isolated role asking for "cloudrun" while the default is the warm runner.
  const { config, employees, runtimes } = deps();
  const employee = employees.get(input.employeeId);
  const role = employee ? resolveRole(employee, input.roleId) : undefined;
  return s.runtimeFor(role, config.SANDBOX_RUNTIME, Object.keys(runtimes));
}

export const taskWorkflow = DBOS.registerWorkflow(taskWorkflowBody, { name: "taskWorkflow" });
