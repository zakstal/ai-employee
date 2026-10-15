#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Fetches a fresh value of a credential the run holds (a GitHub App token lasts one hour) from the control plane,
 * authorised by the run token, and caches it in a 0600 file until 5 minutes before it expires.
 *   ai-employee-credential env NAME   prints that variable of the refreshed grant (GH_TOKEN_REFRESH names the grant)
 *   ai-employee-credential git get    git credential helper: username/password for any host it is asked about
 */
export interface Refreshed {
  env: Record<string, string>;
  expiresAt: string | null;
}
export interface Deps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  now: () => number;
  cacheFile: string;
}

const SKEW_MS = 5 * 60_000;
const FALLBACK_TTL_MS = 5 * 60_000; // a grant with no expiry is re-fetched this often

export async function getCredential(grant: string, d: Deps): Promise<Refreshed> {
  if (existsSync(d.cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(d.cacheFile, "utf8")) as Refreshed & { fetchedAt: number };
      const until = c.expiresAt ? Date.parse(c.expiresAt) - SKEW_MS : c.fetchedAt + FALLBACK_TTL_MS;
      if (until > d.now()) return c;
    } catch {
      /* unreadable cache: refetch */
    }
  }
  const { CONTROL_PLANE_URL, RUN_TOKEN, TASK_ID } = d.env;
  if (!CONTROL_PLANE_URL || !RUN_TOKEN || !TASK_ID) throw new Error("CONTROL_PLANE_URL, RUN_TOKEN and TASK_ID are required");
  const res = await d.fetch(`${CONTROL_PLANE_URL}/credentials/${encodeURIComponent(grant)}/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${RUN_TOKEN}`, "x-task-id": TASK_ID },
  });
  if (!res.ok) throw new Error(`credential refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const fresh = (await res.json()) as Refreshed;
  writeFileSync(d.cacheFile, JSON.stringify({ ...fresh, fetchedAt: d.now() }), { mode: 0o600 });
  chmodSync(d.cacheFile, 0o600);
  return fresh;
}

async function main(): Promise<void> {
  const grant = process.env.GH_TOKEN_REFRESH;
  if (!grant) throw new Error("GH_TOKEN_REFRESH is not set: nothing to refresh");
  const deps: Deps = { env: process.env, fetch, now: Date.now, cacheFile: `${process.env.TMPDIR ?? "/tmp"}/ai-employee-credential-${grant}.json` };
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "git") {
    if (arg !== "get") return; // store/erase: nothing to do
    const token = (await getCredential(grant, deps)).env.GH_TOKEN;
    if (!token) throw new Error("refreshed grant has no GH_TOKEN");
    process.stdout.write(`username=x-access-token\npassword=${token}\n`);
  } else if (cmd === "env" && arg) {
    const v = (await getCredential(grant, deps)).env[arg];
    if (v === undefined) throw new Error(`refreshed grant has no ${arg}`);
    process.stdout.write(v);
  } else throw new Error("usage: ai-employee-credential env NAME | git get");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
