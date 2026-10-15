import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type CredentialSpec, type Employee } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { EnvSecretStore, GcpSecretStore, providerFor, type SecretStore } from "../credentials/index.js";
import { loadEmployees } from "../roles/load.js";

const USAGE = `usage: credentials set   <employee> <grant> [--env NAME] [--from-file path]   (value from stdin or the file, never argv)
       credentials list  <employee>
       credentials check <employee> [grant]
options: --dir <config dir> (repeatable)  --project <gcp project>  --store gcp|env (check; default gcp)`;

export interface Exec {
  (cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const realExec: Exec = (cmd, args, stdin) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.stdin.end(stdin ?? "");
  });

/** The Secret Manager names a login references, keyed by the env var (or role) they feed. */
export function secretRefs(spec: CredentialSpec): Record<string, string> {
  if (spec.kind === "secret") return Object.fromEntries(Object.entries(spec.env).flatMap(([k, v]) => ("secret" in v ? [[k, v.secret]] : [])));
  if (spec.kind === "minted") return { privateKey: spec.privateKey.secret };
  if (spec.kind === "broker") return { secret: spec.secret.secret };
  return {};
}

function find(employees: Map<string, Employee>, id: string, grant: string): CredentialSpec {
  const e = employees.get(id);
  if (!e) throw new Error(`unknown employee "${id}"`);
  const spec = e.credentials?.[grant];
  if (!spec) throw new Error(`employee ${id} defines no credential "${grant}"`);
  return spec;
}

export async function setSecret(employees: Map<string, Employee>, o: { employee: string; grant: string; env?: string | undefined; project: string; value: string }, exec: Exec): Promise<string> {
  const refs = secretRefs(find(employees, o.employee, o.grant));
  const keys = Object.keys(refs);
  if (!keys.length) throw new Error(`credential "${o.grant}" references no secret`);
  const key = o.env ?? (keys.length === 1 ? keys[0]! : undefined);
  if (!key) throw new Error(`credential "${o.grant}" has several secrets (${keys.join(", ")}): pass --env`);
  const name = refs[key];
  if (!name) throw new Error(`credential "${o.grant}" has no secret for "${key}" (${keys.join(", ")})`);
  if (!o.value) throw new Error("empty value");
  const r = await exec("gcloud", ["secrets", "versions", "add", name, "--project", o.project, "--data-file=-"], o.value);
  if (r.code !== 0) {
    if (/NOT_FOUND|not found/i.test(r.stderr)) throw new Error(`secret "${name}" does not exist: add it to the secret shells in the infra values and apply first`);
    throw new Error(`gcloud failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  return `${name}: new version added`;
}

export async function listCredentials(employees: Map<string, Employee>, employee: string, project: string, exec: Exec): Promise<string[]> {
  const e = employees.get(employee);
  if (!e) throw new Error(`unknown employee "${employee}"`);
  const lines: string[] = [];
  for (const [grant, spec] of Object.entries(e.credentials ?? {})) {
    lines.push(`${grant}: ${spec.kind}, env ${providerFor(spec).envNames(spec).join(" ") || "(none)"}`);
    for (const secret of new Set(Object.values(secretRefs(spec)))) {
      const r = await exec("gcloud", ["secrets", "versions", "list", secret, "--project", project, "--limit", "1", "--format=json"], "");
      const v = r.code === 0 ? (JSON.parse(r.stdout || "[]") as { name: string; createTime: string }[])[0] : undefined;
      lines.push(`  secret ${secret}: ${v ? `version ${v.name.split("/").pop()}, created ${v.createTime}` : "no versions (or not readable)"}`);
    }
  }
  return lines;
}

/** Performs the real resolve and prints env names and expiry, never values. Throws on failure. */
export async function checkCredentials(employees: Map<string, Employee>, employee: string, grant: string | undefined, secrets: SecretStore, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const e = employees.get(employee);
  if (!e) throw new Error(`unknown employee "${employee}"`);
  const config = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x" } as NodeJS.ProcessEnv);
  const lines: string[] = [];
  for (const g of grant ? [grant] : Object.keys(e.credentials ?? {})) {
    const spec = find(employees, employee, g);
    const role = e.roles[0]!;
    const r = await providerFor(spec).resolve(g, spec, { employee: e, role, taskId: "credentials-check", config, secrets, fetch: fetchImpl, now: () => new Date() });
    lines.push(`${g}: ${spec.kind}, env ${Object.keys(r.env).join(" ") || "(none)"}${r.expiresAt ? `, expires ${r.expiresAt.toISOString()}` : ""}`);
  }
  return lines;
}

async function readStdin(): Promise<string> {
  let s = "";
  for await (const c of process.stdin) s += c;
  return s;
}

async function main(): Promise<void> {
  const { positionals: p, values: v } = parseArgs({
    allowPositionals: true,
    options: { dir: { type: "string", multiple: true }, project: { type: "string" }, env: { type: "string" }, "from-file": { type: "string" }, store: { type: "string" } },
  });
  const [cmd, employee, grant] = p;
  if (!cmd || !employee || !["set", "list", "check"].includes(cmd)) {
    console.error(USAGE);
    process.exit(2);
  }
  const employees = await loadEmployees((v.dir?.length ? v.dir : [process.env.ROLES_DIR ?? "roles"]).map((d) => path.resolve(d)));
  const project = v.project ?? process.env.GCP_PROJECT ?? "";
  const needProject = () => project || Promise.reject(new Error("pass --project or set GCP_PROJECT"));
  if (cmd === "set") {
    if (!grant) throw new Error(USAGE);
    await needProject();
    const value = (v["from-file"] ? await readFile(v["from-file"], "utf8") : await readStdin()).replace(/\r?\n$/, "");
    console.log(await setSecret(employees, { employee, grant, env: v.env, project, value }, realExec));
  } else if (cmd === "list") {
    await needProject();
    for (const l of await listCredentials(employees, employee, project, realExec)) console.log(l);
  } else {
    const secrets = v.store === "env" ? new EnvSecretStore() : new GcpSecretStore(String(await needProject()));
    for (const l of await checkCredentials(employees, employee, grant, secrets)) console.log(l);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
