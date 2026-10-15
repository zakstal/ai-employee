import type { Employee, Orchestrator, SandboxRuntime } from "@ai-employee/core";
import type { Ledger } from "../db/ledger.js";
import type { Config } from "../config.js";
import type { SlackClient } from "../slack/client.js";
import type { ClickUpClient } from "../clickup/client.js";
import type { SecretStore } from "../credentials/types.js";

/**
 * Dependencies for workflow steps. Set once at boot. Steps read from here so
 * the workflow body stays a pure sequence of step calls (engine-portable).
 */
export interface WorkflowDeps {
  config: Config;
  ledger: Ledger;
  employees: Map<string, Employee>;
  runtimes: Record<string, SandboxRuntime>;
  slack: SlackClient;
  clickup: ClickUpClient;
  /** Where per-employee `secret:` credential references are read. */
  secrets: SecretStore;
  /** Used by the cron tick (fireDueSchedules) to start tasks. */
  orchestrator: Orchestrator;
}

let current: WorkflowDeps | undefined;
export function setWorkflowDeps(d: WorkflowDeps): void {
  current = d;
}
export function deps(): WorkflowDeps {
  if (!current) throw new Error("workflow deps not configured");
  return current;
}
