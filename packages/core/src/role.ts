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
  /** Id of a registered collector: azure-errors, clickup-channels, github-prs, github-checks, clickup-task-status, git-branches, or a plugin. Checked against the registry at boot and in `config check`. */
  collector: z.string().min(1),
  everyMin: z.number().int().min(1).max(1440).default(5),
  role: z.string().min(1),
  description: z.string().default(""),
  config: z.record(z.unknown()).default({}),
  /** Name of one of the employee's logins the collector signs in with: kind `broker` or `federated` for azure-errors (without it the global AZURE_* env is read); a GitHub token login for the github-* and git-branches collectors (default grant `github`). */
  credential: z.string().optional(),
});
export type Monitor = z.infer<typeof MonitorSchema>;

/**
 * Schedule = a cron entry kept in the employee file (config as code) and reconciled into the database at boot.
 * Schedules an agent creates at runtime stay possible; config ones win a name clash and cannot be deleted over HTTP.
 */
export const ScheduleSchema = z
  .object({
    cron: z.string().min(1),
    /** IANA zone; default is the control plane's DEFAULT_TZ. */
    timezone: z.string().min(1).optional(),
    role: z.string().min(1),
    prompt: z.string().min(1).optional(),
    /** Path (relative to the config dirs) of a markdown file whose contents become `prompt`. Exactly one of prompt / promptFile. */
    promptFile: z.string().min(1).optional(),
    deliverTo: z.object({ channel: z.enum(["clickup", "clickup-chat"]), threadRef: z.string().min(1) }),
    enabled: z.boolean().default(true),
  })
  .refine((s) => Number(!!s.prompt) + Number(!!s.promptFile) === 1, { message: "exactly one of prompt or promptFile is required" });
export type ScheduleConfig = z.infer<typeof ScheduleSchema>;

/**
 * Backlog = a list of work items the manager role dispatches from, with limits the system enforces.
 * The manager reads it from here (rendered into its prompt with the computed state) instead of from prose.
 */
export const BacklogSchema = z.object({
  description: z.string().default(""),
  /** false: the manager is told it is disabled and dispatch for it is refused (409). */
  enabled: z.boolean().default(true),
  source: z.discriminatedUnion("kind", [
    /** A markdown task list in a repo: `## Phase N` headings and `- [ ] item <!-- depends: other -->` lines. */
    z.object({ kind: z.literal("repo-file"), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"), ref: z.string().default("main"), path: z.string().min(1) }),
    /** Tasks of a ClickUp list; an item is done when its status is one of `doneStatuses`. */
    z.object({ kind: z.literal("clickup-list"), listId: z.string().min(1), doneStatuses: z.array(z.string()).default(["complete", "closed", "done"]) }),
  ]),
  /** Employee credential (or built-in grant) the control plane itself reads the source and PR state with. */
  credential: z.string().default("github"),
  /** `file`: file order. `phase`: by phase number, then file order. */
  order: z.enum(["file", "phase"]).default("file"),
  /** `merged`: phase N+1 waits until every item of earlier phases is merged. */
  phaseGate: z.enum(["none", "merged"]).default("none"),
  /** Role the manager spawns for an item, and the brief template ({{item}} {{backlog}} {{branch}} {{base}}, filled at dispatch). */
  dispatch: z.object({ role: z.string().min(1), brief: z.string().min(1) }),
  concurrency: z.number().int().min(1).max(10).default(1),
  done: z
    .object({
      /** repo-file sources only; a clickup-list item is done by its status. */
      rule: z.enum(["pr-open", "pr-merged", "branch-pushed"]).default("pr-open"),
      /** Base branch of the item's PR (default: the source ref). */
      base: z.string().optional(),
      branchPattern: z.string().default("ai/{{backlog}}/{{item}}"),
    })
    .default({}),
  guards: z
    .object({
      maxTasksPerDay: z.number().int().positive().optional(),
      maxCostUsdPerDay: z.number().positive().optional(),
      maxAttemptsPerItem: z.number().int().positive().default(2),
      stopAfterConsecutiveFailures: z.number().int().positive().default(3),
    })
    .default({}),
});
export type Backlog = z.infer<typeof BacklogSchema>;

export const EmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  defaultRole: z.string().min(1),
  roles: z.array(RoleSchema).min(1),
  /** Named entry points for POST /agents { workstream }, resolving to a starting role. */
  workstreams: z.record(z.object({ entryRole: z.string().min(1), description: z.string().optional() })).default({}),
  monitors: z.record(MonitorSchema).default({}),
  /** Backlogs the manager works through (see BacklogSchema). */
  backlogs: z.record(BacklogSchema).optional(),
  /** Cron schedules defined in config, reconciled into the database at boot (see ScheduleSchema). */
  schedules: z.record(ScheduleSchema).optional(),
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
