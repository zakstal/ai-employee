import { DBOS } from "@dbos-inc/dbos-sdk";
import { listDue, markFired, taskFor } from "../schedules/tick.js";
import * as manager from "../manager/tick.js";
import * as monitors from "../monitors/tick.js";
import { deps } from "./deps.js";
import { taskWorkflow } from "./workflow.js";

/**
 * Runs every minute; fires any schedule whose next_fire_at has arrived.
 * Reads and ledger writes are steps; the child task workflow is started from the
 * workflow body (DBOS rejects startWorkflow from inside a step). The workflow ID
 * doubles as the dedup key, so a re-run of this tick cannot double-fire.
 */
async function scheduleTickBody(scheduledTime: Date): Promise<void> {
  // Two control planes share this DB (VM primary, parked Cloud Run fallback). Only one may fire schedules and
  // monitors, or every tick races the same minute and the loser's tasks run with the wrong config.
  const enabled = await DBOS.runStep(() => Promise.resolve(deps().config.TICK_ENABLED), { name: "tickEnabled" });
  if (!enabled) return;
  const due = await DBOS.runStep(() => listDue(scheduledTime), { name: "listDue" });
  for (const schedule of due) {
    const { taskId, input } = taskFor(schedule);
    await DBOS.runStep(() => deps().ledger.createTask(taskId, input), { name: "createTask" });
    await DBOS.startWorkflow(taskWorkflow, { workflowID: taskId })(taskId, input);
    await DBOS.runStep(() => markFired(schedule, scheduledTime), { name: "markFired" });
  }
  // Monitors: deterministic collectors; a task (and so model tokens) only when something is new.
  const dueMonitors = await DBOS.runStep(() => monitors.listDueMonitors(scheduledTime), { name: "listDueMonitors" });
  for (const d of dueMonitors) {
    const collected = await DBOS.runStep(() => monitors.collectSafely(d, scheduledTime), { name: "collect", retriesAllowed: false });
    const fire = collected.findings.length > 0;
    if (fire) {
      const { taskId, input } = monitors.taskFor(d, collected.findings, scheduledTime);
      await DBOS.runStep(() => deps().ledger.createTask(taskId, input), { name: "createMonitorTask" });
      await DBOS.startWorkflow(taskWorkflow, { workflowID: taskId })(taskId, input);
    }
    await DBOS.runStep(() => monitors.saveRun(d, collected.state, scheduledTime, fire), { name: "saveMonitorRun" });
  }
  // Manager: event-driven, not scheduled. A wake is pending only when backlog work finished; the claim is
  // debounced so a burst of completions produces one run.
  for (const employeeId of await DBOS.runStep(() => Promise.resolve([...deps().employees.keys()]), { name: "employeeIds" })) {
    const wake = await DBOS.runStep(() => manager.claim(employeeId, scheduledTime), { name: "claimManagerWake" });
    if (!wake) continue;
    await DBOS.runStep(() => deps().ledger.createTask(wake.taskId, wake.input), { name: "createManagerTask" });
    await DBOS.startWorkflow(taskWorkflow, { workflowID: wake.taskId })(wake.taskId, wake.input);
  }
}

DBOS.registerScheduled(DBOS.registerWorkflow(scheduleTickBody, { name: "scheduleTick" }), { crontab: "* * * * *" });
