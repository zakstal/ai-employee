import { z } from "zod";

export const LIMIT_POLICIES = ["failover", "wait", "failover-then-wait", "off"] as const;

/** Runtime-switchable behaviour, stored in Postgres (`engine_settings`, key `claude`) and read on every decision. */
export const ClaudeSettingsSchema = z.object({
  /** What a task does when its Claude account hits a usage limit (and what launch does when no account has headroom). */
  limitPolicy: z.enum(LIMIT_POLICIES).default("failover-then-wait"),
  /** Let tasks run on accounts that have spilled into paid overage. */
  allowOverage: z.boolean().default(false),
  /** Utilization (0..1) of the 5h or 7d window at which an alert is sent, once per window. */
  warnAt: z.number().min(0).max(1).default(0.8),
  /** Account names in order of preference; empty = most 5h headroom first. */
  preferred: z.array(z.string().min(1)).default([]).transform((l) => [...new Set(l.map((n) => n.trim().toLowerCase()))]),
});
export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

/** PUT body: any subset of the settings; omitted fields keep their current value. Unknown keys are rejected (a typo must not be silently ignored). */
export const ClaudeSettingsPatchSchema = ClaudeSettingsSchema.partial().strict();
export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = ClaudeSettingsSchema.parse({});
