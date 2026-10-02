import { DBOS } from "@dbos-inc/dbos-sdk";
import path from "node:path";
import { CloudRunJobRuntime, KubernetesJobRuntime, LocalProcessRuntime, WarmRunnerRuntime } from "@ai-employee/adapters";
import type { SandboxRuntime } from "@ai-employee/core";
import { loadConfig } from "./config.js";
import { Ledger } from "./db/ledger.js";
import { migrate } from "./db/migrate.js";
import { closePool, getPool } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { setWorkflowDeps } from "./orchestration/deps.js";
import { DbosOrchestrator } from "./orchestration/dbos-orchestrator.js";
import { registerDigestWorkflow } from "./orchestration/digest-workflow.js";
import { loadEmployees } from "./roles/load.js";
import { HttpSlackClient } from "./slack/client.js";
import { HttpClickUpClient } from "./clickup/client.js";
// Side-effect import: registers the cron-tick scheduled workflow before DBOS.launch().
import "./orchestration/schedule-workflow.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await migrate(config.DATABASE_URL);

  const pool = getPool(config.DATABASE_URL);
  const ledger = new Ledger(pool);
  const employees = await loadEmployees(path.resolve(config.ROLES_DIR));
  for (const e of employees.values()) await ledger.ensureEmployee(e.id, e.name);

  // Only construct the runtime the deployment selected: k8s needs a kubeconfig, cloudrun needs GCP ADC.
  const runtimes: Record<string, SandboxRuntime> = {
    local: new LocalProcessRuntime(() => config.LOCAL_RUNNER_CMD.split(" ")),
  };
  if (config.SANDBOX_RUNTIME === "k8s") runtimes.k8s = new KubernetesJobRuntime();
  if (config.SANDBOX_RUNTIME === "warm") {
    if (!config.RUNNER_TOKEN) throw new Error("SANDBOX_RUNTIME=warm requires RUNNER_TOKEN");
    runtimes.warm = new WarmRunnerRuntime({ baseUrl: config.WARM_RUNNER_URL, token: config.RUNNER_TOKEN });
  }
  // Cloud Run Jobs stay registered as the isolated tier (roles opt in with `runtime: cloudrun`) on any GCP deployment.
  if (config.SANDBOX_RUNTIME === "cloudrun" || (config.SANDBOX_RUNTIME === "warm" && config.GCP_PROJECT)) {
    if (!config.GCP_PROJECT) throw new Error("SANDBOX_RUNTIME=cloudrun requires GCP_PROJECT");
    runtimes.cloudrun = new CloudRunJobRuntime({ projectId: config.GCP_PROJECT, region: config.GCP_REGION, jobPrefix: config.CLOUDRUN_JOB_PREFIX });
  }
  const slack = new HttpSlackClient(config.SLACK_BOT_TOKEN);
  const clickup = new HttpClickUpClient(config.CLICKUP_API_TOKEN);
  const orchestrator = new DbosOrchestrator(ledger);
  setWorkflowDeps({ config, ledger, employees, runtimes, slack, clickup, orchestrator });

  DBOS.setConfig({ name: "ai-employee", systemDatabaseUrl: config.DBOS_SYSTEM_DATABASE_URL });
  registerDigestWorkflow(config);
  await DBOS.launch();

  const app = buildServer({ config, ledger, orchestrator, employees, slack, clickup });
  // Dual-stack where available, IPv4 otherwise.
  try {
    await app.listen({ port: config.PORT, host: "::" });
  } catch {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  }
  app.log.info({ employees: [...employees.keys()], runtime: config.SANDBOX_RUNTIME }, "control plane up");

  const shutdown = async () => {
    await app.close();
    await DBOS.shutdown();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
