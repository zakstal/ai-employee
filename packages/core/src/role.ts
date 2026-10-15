import { z } from "zod";
import { CredentialSpecSchema } from "./credentials.js";

/**
 * Role = deterministic capability config for an employee. Lives in git as YAML,
 * validated at boot. Assignment is a lookup, never model judgment.
 */
export const RoleSchema = z.object({
  id: z.string().min(1),
  description: z.string().default(""),
  systemPrompt: z.string().default(""),
  /** Path (relative to the roles dir) of a markdown file whose contents become systemPrompt. */
  systemPromptFile: z.string().optional(),
  /** Several prompt files, read in order and joined with a blank line (replaces systemPromptFile). */
  systemPromptFiles: z.array(z.string()).optional(),
  /** Harness tool allowlist, e.g. ["Read","Grep","Bash(git *)"]. */
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  /** Claude Code --mcp-config compatible object. */
  mcpServers: z.record(z.unknown()).default({}),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().default(50),
  runtime: z.enum(["k8s", "fake", "namespace", "cloudrun"]).default("k8s"),
  image: z.string().optional(),
  /** Key into RUNNER_IMAGES (e.g. "runner-ops"): picks the image and the Cloud Run Job `${prefix}-${key}`. Wins over `image`. */
  imageRef: z.string().optional(),
  /** Honoured by the k8s/warm tiers. On Cloud Run Jobs the Job template's limits win (overrides carry no
   *  resources), so changing these does nothing for a `runtime: cloudrun` role — edit infra/gcp-cloudrun. */
  cpu: z.number().positive().default(1),
  memoryMb: z.number().int().positive().default(2048),
  timeoutSec: z.number().int().positive().default(1800),
  /** Named credential grants resolved by the control plane into short-lived tokens. */
  credentials: z.array(z.string()).default([]),
  /** Names of the employee's `credentials` this role may use. Same meaning as the legacy `credentials` list above, which stays accepted as an alias. */
  grants: z.array(z.string()).optional(),
  /** Repositories cloned into /workspace before the harness starts (needs the github grant for private repos). */
  repos: z
    .array(z.object({ url: z.string().url(), ref: z.string().optional(), path: z.string().optional() }))
    .default([]),
  /** Named permissions beyond the tool allowlist, e.g. ["schedules"] to create cron schedules. */
  capabilities: z.array(z.string()).default([]),
  /** Role ids this role may create schedules for, in addition to itself. */
  canSchedule: z.array(z.string()).default([]),
  /** Role ids this role may spawn as child agents via POST /agents. */
  canSpawn: z.array(z.string()).default([]),
});
export type Role = z.infer<typeof RoleSchema>;

/**
 * Monitor = a deterministic collector (no model) run every `everyMin` minutes while enabled. Only when it
 * finds something new does it start a task for `role` with the findings. Enabled state lives in the DB
 * (default OFF); the definition lives here.
 */
export const MonitorSchema = z.object({
  collector: z.enum(["azure-errors", "clickup-channels"]),
  everyMin: z.number().int().min(1).max(1440).default(5),
  role: z.string().min(1),
  description: z.string().default(""),
  config: z.record(z.unknown()).default({}),
  /** Name of one of the employee's `credentials` (kind `broker` or `federated`) the azure-errors collector signs in with. Without it the collector reads the global AZURE_* env. */
  credential: z.string().optional(),
});
export type Monitor = z.infer<typeof MonitorSchema>;

export const EmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  defaultRole: z.string().min(1),
  roles: z.array(RoleSchema).min(1),
  /** Named entry points for POST /agents { workstream }, resolving to a starting role. */
  workstreams: z.record(z.object({ entryRole: z.string().min(1), description: z.string().optional() })).default({}),
  monitors: z.record(MonitorSchema).default({}),
  /** Values for `{{NAME}}` in prompts. Built in: BOT_NAME, EMPLOYEE_ID, PR_SIGNATURE. */
  vars: z.record(z.string()).optional(),
  /** Named logins and how to obtain each (see CredentialSpecSchema). Without it, grants resolve to the built-in env-based ones. */
  credentials: z.record(CredentialSpecSchema).optional(),
  /** `jobPrefix` replaces CLOUDRUN_JOB_PREFIX for this employee's `imageRef` roles, so each employee can run on its own Cloud Run jobs (and service account). */
  sandbox: z.object({ jobPrefix: z.string().min(1).optional() }).optional(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

export function resolveRole(employee: Employee, roleId?: string): Role {
  const id = roleId ?? employee.defaultRole;
  const role = employee.roles.find((r) => r.id === id);
  if (!role) throw new Error(`employee ${employee.id} has no role ${id}`);
  return role;
}

/** The credential names a role may use: `grants`, else the legacy `credentials` list. */
export function roleGrants(role: Pick<Role, "grants" | "credentials">): string[] {
  return role.grants ?? role.credentials;
}
