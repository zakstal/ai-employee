import { DBOS } from "@dbos-inc/dbos-sdk";
import type { TaskInput } from "@ai-employee/core";
import { resolveRole } from "@ai-employee/core";
import { deps } from "./deps.js";
import * as s from "./steps.js";

/**
 * The ONE workflow body. Rules (see core/orchestrator.ts): only step calls
 * and waits, no IO, no clock, no randomness, no env reads. Written so a
 * Temporal port is a line-for-line translation.
 */
async function taskWorkflowBody(taskId: string, input: TaskInput): Promise<void> {
  const ack = await DBOS.runStep(() => s.acknowledge(input), { name: "acknowledge" });
  const spec = await DBOS.runStep(() => s.buildRunSpec(taskId, input), { name: "buildRunSpec" });
  const runtimeName = await DBOS.runStep(() => pickRuntime(input), { name: "pickRuntime" });
  const handle = await DBOS.runStep(() => s.launchSandbox(spec, runtimeName), { name: "launchSandbox" });
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
  if (role?.runtime && role.runtime !== "k8s" && runtimes[role.runtime]) return role.runtime;
  return config.SANDBOX_RUNTIME;
}

export const taskWorkflow = DBOS.registerWorkflow(taskWorkflowBody, { name: "taskWorkflow" });
