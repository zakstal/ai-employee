import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Config } from "../config.js";
import { ClaudeService } from "../claude/service.js";
import { deps } from "./deps.js";

async function usageCheckBody(): Promise<void> {
  // Only the control plane that owns the tick probes; a parked secondary sharing the DB must not double the traffic.
  if (!deps().config.TICK_ENABLED) return;
  const { config, ledger, clickup } = deps();
  if (config.claudeAccounts.length === 0) return;
  await DBOS.runStep(() => new ClaudeService({ config, ledger, clickup }).refresh(), { name: "probeClaudeAccounts", retriesAllowed: false });
}

const usageCheckWorkflow = DBOS.registerWorkflow(usageCheckBody, { name: "claudeUsageCheck" });

/** Probes every Claude account every CLAUDE_USAGE_CHECK_MIN minutes. Registered before DBOS.launch(). */
export function registerUsageWorkflow(config: Config): void {
  DBOS.registerScheduled(usageCheckWorkflow, { crontab: `*/${config.CLAUDE_USAGE_CHECK_MIN} * * * *` });
}
