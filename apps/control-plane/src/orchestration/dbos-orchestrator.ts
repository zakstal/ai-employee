import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Orchestrator, StartResult, TaskInput, TaskStatus } from "@ai-employee/core";
import type { Ledger } from "../db/ledger.js";
import { deps } from "./deps.js";
import { taskWorkflow } from "./workflow.js";

/**
 * DBOS implementation of the Orchestrator boundary.
 * Dedup is two-layered: the ledger row insert (ON CONFLICT DO NOTHING) is the
 * source of truth for "already triggered"; the DBOS workflowID (same value) is
 * the backstop so a crash between insert and start still executes exactly once.
 */
export class DbosOrchestrator implements Orchestrator {
  constructor(private ledger: Ledger) {}

  async startTask(taskId: string, input: TaskInput): Promise<StartResult> {
    const created = await this.ledger.createTask(taskId, input);
    if (!created) return { started: false, status: await this.status(taskId) };
    await DBOS.startWorkflow(taskWorkflow, { workflowID: taskId })(taskId, input);
    return { started: true, status: "queued" };
  }

  async signal(taskId: string, name: string, payload: unknown): Promise<void> {
    await DBOS.send(taskId, payload, name);
  }

  async cancel(taskId: string): Promise<void> {
    const row = await this.ledger.getTask(taskId);
    if (!row || !(row.status === "queued" || row.status === "running" || row.status === "awaiting_input")) return;
    await DBOS.cancelWorkflow(taskId);
    // The workflow will not reach its finalize step after cancellation, so tear down the sandbox here.
    if (row.run_handle) {
      const rt = deps().runtimes[row.run_handle.adapter];
      await rt?.cancel(row.run_handle);
    }
    await this.ledger.setStatus(taskId, "cancelled");
  }

  async status(taskId: string): Promise<TaskStatus> {
    const row = await this.ledger.getTask(taskId);
    return row?.status ?? "unknown";
  }

  async schedule(): Promise<void> {
    // ponytail: cron slice not in milestone one. DBOS.registerScheduled needs
    // registration at boot; implement as a table of schedules loaded at launch.
    throw new Error("schedule() not implemented yet");
  }
}
