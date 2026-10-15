import { DBOS } from "@dbos-inc/dbos-sdk";
import { CloudRunJobRuntime, KubernetesJobRuntime, LocalProcessRuntime, WarmRunnerRuntime } from "@ai-employee/adapters";
import type { SandboxRuntime } from "@ai-employee/core";
import { configDirs, loadConfig } from "./config.js";
import { Ledger } from "./db/ledger.js";
import { migrate } from "./db/migrate.js";
import { closePool, getPool } from "./db/pool.js";
import { buildServer } from "./http/server.js";
import { EnvSecretStore, GcpSecretStore } from "./credentials/index.js";
import { setWorkflowDeps } from "./orchestration/deps.js";
import { DbosOrchestrator } from "./orchestration/dbos-orchestrator.js";
import { registerDigestWorkflow } from "./orchestration/digest-workflow.js";
import { loadPlugins, monitorProblems } from "./collectors/index.js";
import { reconcileSchedules } from "./schedules/reconcile.js";
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
  const employees = await loadEmployees(configDirs(config));
  // Collector plugins come from the config dirs. A broken one is logged loudly and skipped; a monitor that needs it then fails below.
  const plugins = await loadPlugins(configDirs(config));
  for (const err of plugins.errors) console.error(err);
  if (plugins.loaded.length) console.log(`collector plugins: ${plugins.loaded.join(", ")}`);
  const bad = monitorProblems(employees.values());
  if (bad.length) throw new Error(`invalid monitor config:\n  ${bad.join("\n  ")}`);
  for (const e of employees.values()) await ledger.ensureEmployee(e.id, e.name);
  // Only the control plane that owns the tick writes schedules; a parked secondary sharing the DB must not.
  if (config.TICK_ENABLED) await reconcileSchedules({ ledger, employees, defaultTz: config.DEFAULT_TZ, log: (m) => console.log(m) });

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
  if (config.SECRET_STORE === "gcp" && !config.GCP_PROJECT) throw new Error("SECRET_STORE=gcp requires GCP_PROJECT");
  const secrets = config.SECRET_STORE === "gcp" ? new GcpSecretStore(config.GCP_PROJECT) : new EnvSecretStore();
  setWorkflowDeps({ config, ledger, employees, runtimes, slack, clickup, secrets, orchestrator });

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
