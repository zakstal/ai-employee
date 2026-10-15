import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CloudRunJobRuntime } from "@ai-employee/adapters";
import type { Role } from "@ai-employee/core";
import { loadConfig, type Config } from "../config.js";
import { loadEmployees } from "../roles/load.js";
import { environmentFooter, resolveCredentials, resolvableMcpServers, runtimeFor } from "../orchestration/steps.js";

export interface ResolveOptions {
  dirs: string[];
  /** Env var names that are non-empty on the live control plane. Omitted = every credential counts as set (structural view). */
  liveEnvNames?: string[] | undefined;
  sandboxRuntime?: Config["SANDBOX_RUNTIME"] | undefined;
  managerRole?: string | undefined;
}

export interface Resolved {
  json: Record<string, unknown>;
  /** Full system prompt per `<employee>.<role>`, as a run would receive it. */
  prompts: Record<string, string>;
}

const SENTINEL = "SECRET-SENTINEL-VALUE";
const VERTEX = ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"];

/** Run `fn` with process.env replaced, so the dump never depends on the caller's environment. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export async function resolveEffectiveConfig(opts: ResolveOptions): Promise<Resolved> {
  const employees = await loadEmployees(opts.dirs);
  // Credential values never reach the output: only which env names a role would receive.
  const live = opts.liveEnvNames ? new Set(opts.liveEnvNames) : undefined;
  const base = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", SANDBOX_RUNTIME: opts.sandboxRuntime, MANAGER_ROLE: opts.managerRole } as NodeJS.ProcessEnv);
  const config = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, typeof v === "string" && v === "" ? (live ? (live.has(k) ? SENTINEL : "") : SENTINEL) : v]),
  ) as Config;
  const procEnv = Object.fromEntries(VERTEX.filter((k) => (live ? live.has(k) : true)).map((k) => [k, SENTINEL]));
  const registered = ["local", config.SANDBOX_RUNTIME, ...(config.SANDBOX_RUNTIME === "cloudrun" || (config.SANDBOX_RUNTIME === "warm" && config.GCP_PROJECT) ? ["cloudrun"] : [])];
  const jobs = new CloudRunJobRuntime({ projectId: "p", region: "r", jobPrefix: config.CLOUDRUN_JOB_PREFIX, client: { jobs: {} as never, executions: {} as never } });

  const prompts: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  for (const e of [...employees.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const roles: Record<string, unknown> = {};
    for (const role of e.roles) {
      const prompt = `${role.systemPrompt.trimEnd()}\n\n${environmentFooter(role)}`;
      prompts[`${e.id}.${role.id}`] = prompt;
      roles[role.id] = withEnv(procEnv, () => describeRole(role, config, registered, jobs, prompt));
    }
    out[e.id] = { name: e.name, defaultRole: e.defaultRole, workstreams: e.workstreams, monitors: e.monitors, roles };
  }
  return {
    json: sortKeys({
      schemaVersion: 1,
      source: { gitSha: gitSha(), dirs: opts.dirs },
      env: { managerRole: base.MANAGER_ROLE, sandboxRuntime: config.SANDBOX_RUNTIME, cloudRunJobPrefix: config.CLOUDRUN_JOB_PREFIX, defaultEmployeeId: config.DEFAULT_EMPLOYEE_ID, defaultTz: base.DEFAULT_TZ, digestTz: base.DIGEST_TZ || base.DEFAULT_TZ },
      employees: out,
    }) as Record<string, unknown>,
    prompts,
  };
}

function describeRole(role: Role, config: Config, registered: string[], jobs: CloudRunJobRuntime, prompt: string) {
  const envNames = Object.keys(resolveCredentials(role.credentials, config)).sort();
  const runtimeUsed = runtimeFor(role, config.SANDBOX_RUNTIME, registered);
  const image = role.image ?? config.RUNNER_IMAGE;
  return {
    model: role.model ?? null,
    maxTurns: role.maxTurns,
    timeoutSec: role.timeoutSec,
    cpu: role.cpu,
    memoryMb: role.memoryMb,
    runtime: role.runtime,
    runtimeUsed,
    image: role.image ?? null,
    imageResolved: image,
    cloudRunJob: runtimeUsed === "cloudrun" ? jobs.jobPathFor(image).split("/").pop() : null,
    credentials: role.credentials,
    credentialEnvNames: envNames,
    allowedTools: role.allowedTools,
    disallowedTools: role.disallowedTools,
    mcpServers: role.mcpServers,
    mcpServersResolvable: Object.keys(resolvableMcpServers(role.mcpServers, Object.fromEntries(envNames.map((n) => [n, SENTINEL])))).sort(),
    repos: role.repos,
    capabilities: role.capabilities,
    canSchedule: role.canSchedule,
    canSpawn: role.canSpawn,
    systemPrompt: { bytes: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex"), file: role.systemPromptFile ?? null, ...(role.systemPromptFiles ? { files: role.systemPromptFiles } : {}) },
  };
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

