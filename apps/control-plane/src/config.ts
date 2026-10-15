import { z } from "zod";

const Env = z.object({
  // Not .url(): Cloud SQL socket URLs (postgres://u:p@/db?host=/cloudsql/...) have no host.
  DATABASE_URL: z.string().min(1),
  DBOS_SYSTEM_DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  SLACK_SIGNING_SECRET: z.string().default(""),
  SLACK_BOT_TOKEN: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  /** From `claude setup-token` (Pro/Max/Team/Enterprise). One-year OAuth token; shares the subscription's usage limits. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().default(""),
  RUNNER_IMAGE: z.string().default("ai-employee-runner:dev"),
  // ---- static tool credentials, injected per role grant (ponytail: mint short-lived tokens per run later)
  CLICKUP_API_TOKEN: z.string().default(""),
  CLICKUP_TEAM_ID: z.string().default(""),
  CLICKUP_WEBHOOK_SECRET: z.string().default(""),
  /** ClickUp user id of the bot account; used for assignee triggers and comment loop-guard. */
  CLICKUP_BOT_USER_ID: z.string().default(""),
  /** Word in a comment that summons the employee. Default "!<DEFAULT_EMPLOYEE_ID>" ("@" opens ClickUp's mention picker). */
  CLICKUP_TRIGGER_WORD: z.string().default(""),
  /** Shared secret the Chat Automation sends in X-Bot-Secret. */
  CLICKUP_CHAT_SECRET: z.string().default(""),
  /** How many prior channel messages to include as conversation memory. */
  CLICKUP_CHAT_HISTORY: z.coerce.number().int().min(0).max(100).default(20),
  GH_TOKEN: z.string().default(""),
  AZURE_CLIENT_ID: z.string().default(""),
  AZURE_TENANT_ID: z.string().default(""),
  AZURE_CLIENT_SECRET: z.string().default(""),
  AZURE_SUBSCRIPTION_ID: z.string().default(""),
  /** Azure token broker (VM sidecar holding a human `az login`); speaks the App Service managed-identity protocol. */
  AZURE_BROKER_URL: z.string().default(""),
  AZURE_BROKER_SECRET: z.string().default(""),
  /** Where sandboxes run. Deployment decides; roles do not. */
  SANDBOX_RUNTIME: z.enum(["k8s", "local", "cloudrun", "warm"]).default("k8s"),
  /** Warm runner (long-lived runner container) for SANDBOX_RUNTIME=warm. */
  WARM_RUNNER_URL: z.string().default("http://runner:8080"),
  RUNNER_TOKEN: z.string().default(""),
  GCP_PROJECT: z.string().default(""),
  GCP_REGION: z.string().default("us-central1"),
  /** Cloud Run Job per runner image: `${prefix}-runner`, `${prefix}-runner-ops`. */
  CLOUDRUN_JOB_PREFIX: z.string().default("ai-employee"),
  ROLES_DIR: z.string().default("roles"),
  /** Employee that owns Slack traffic until per-channel routing exists. */
  DEFAULT_EMPLOYEE_ID: z.string().default("dev"),
  /** Only for SANDBOX_RUNTIME=local: command to run the runner. */
  LOCAL_RUNNER_CMD: z.string().default("node ../runner/dist/index.js"),
  /** ClickUp chat channel id for failure alerts and the daily digest. Unset = both disabled. */
  ALERT_CHANNEL_ID: z.string().default(""),
  /** Role woken when backlog work finishes. Empty disables the manager entirely. */
  MANAGER_ROLE: z.string().default(""),
  /** Minimum seconds between manager runs, so a burst of completions is one wake. */
  MANAGER_DEBOUNCE_SEC: z.coerce.number().int().positive().default(300),
  /** Wake the manager anyway after this many minutes of silence, so a stall is noticed. 0 disables. */
  MANAGER_HEARTBEAT_MIN: z.coerce.number().int().nonnegative().default(60),
  /** false on any secondary control plane sharing the DB (the parked Cloud Run one): only one tick may run. */
  TICK_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Crontab (5-field, local to DIGEST_TZ, else DEFAULT_TZ) for the daily digest. */
  DIGEST_CRON: z.string().default("0 8 * * *"),
  /** IANA zone for the digest. Empty = DEFAULT_TZ. */
  DIGEST_TZ: z.string().default(""),
  /** IANA zone for schedules created without one, and the digest unless DIGEST_TZ is set. */
  DEFAULT_TZ: z.string().default("America/Los_Angeles"),
});

export type Config = z.infer<typeof Env>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
