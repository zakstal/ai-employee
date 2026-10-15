import type { z } from "zod";
import type { Employee, Monitor } from "@ai-employee/core";
import type { Config } from "../config.js";
import type { ClickUpClient } from "../clickup/client.js";
import type { SecretStore } from "../credentials/types.js";
import type { CollectResult } from "../monitors/types.js";

export interface CollectContext {
  employee: Employee;
  monitorName: string;
  monitor: Monitor;
  now: Date;
  fetch: typeof fetch;
  clickup: ClickUpClient;
  config: Config;
  secrets: SecretStore;
  /** Env of one of the employee's credentials (or a built-in grant) for the control plane itself, no sandbox. Never log it. */
  credential(name: string): Promise<Record<string, string>>;
}

/**
 * A monitor's collector: deterministic, no model. `monitors.<name>.collector` names its `id`; the monitor's `config`
 * is validated against `configSchema` at boot and in `config check`.
 */
export interface Collector<C = unknown> {
  readonly id: string;
  readonly configSchema: z.ZodType<C, z.ZodTypeDef, unknown>;
  /** Returns findings and the next state. The first run (empty `prev`) records a baseline and reports nothing. */
  collect(ctx: CollectContext, config: C, prev: Record<string, unknown>): Promise<CollectResult>;
}
