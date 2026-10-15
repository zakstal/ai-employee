import { readFile } from "node:fs/promises";
import type { CredentialSpec } from "@ai-employee/core";
import { providerFor } from "../credentials/index.js";
import { resolveEffectiveConfig, type ResolveOptions } from "./resolve.js";

export interface CheckOptions extends ResolveOptions {
  /** `--public`: also scan every loaded string against this deny list (plain words, or `re:<regex>` lines). */
  denyFile?: string | undefined;
}

type Role = { credentials: string[]; canSpawn: string[]; canSchedule: string[]; mcpServers: Record<string, unknown>; mcpServersResolvable: string[] };
type Emp = { credentials?: Record<string, CredentialSpec>; defaultRole: string; roles: Record<string, Role>; workstreams: Record<string, { entryRole: string }>; monitors: Record<string, { role: string }> };

/** Every problem found, empty when the config is sound. Schema, prompt files and extends errors surface from the loader as one problem. */
export async function checkConfig(opts: CheckOptions): Promise<string[]> {
  let resolved;
  try {
    resolved = await resolveEffectiveConfig(opts);
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
  const problems: string[] = [];
  const employees = resolved.json.employees as Record<string, Emp>;
  const managerRole = (resolved.json.env as { managerRole: string }).managerRole;
  for (const [id, e] of Object.entries(employees)) {
    const has = (r: string) => r in e.roles;
    const ref = (where: string, r: string) => has(r) || problems.push(`${id}: ${where} names unknown role "${r}"`);
    ref("defaultRole", e.defaultRole);
    for (const [n, w] of Object.entries(e.workstreams)) ref(`workstream ${n} entryRole`, w.entryRole);
    for (const [n, m] of Object.entries(e.monitors)) ref(`monitor ${n} role`, m.role);
    if (managerRole) ref("manager role", managerRole);
    for (const [rid, r] of Object.entries(e.roles)) {
      for (const t of r.canSpawn) ref(`role ${rid} canSpawn`, t);
      for (const t of r.canSchedule) ref(`role ${rid} canSchedule`, t);
      // The runtime silently drops an MCP server whose ${VAR} no credential provides; here that is an error.
      // `credentials` here is the role's grants (an unknown one already fails in resolve).
      // Two of the role's own logins must not set the same env var.
      const owner = new Map<string, string>();
      for (const g of r.credentials) {
        const spec = e.credentials?.[g];
        if (!spec) continue;
        for (const n of providerFor(spec).envNames(spec)) {
          const prev = owner.get(n);
          if (prev && prev !== g) problems.push(`${id}: role ${rid} grants "${prev}" and "${g}", which both set ${n}`);
          owner.set(n, g);
        }
      }
      for (const s of Object.keys(r.mcpServers)) {
        if (!r.mcpServersResolvable.includes(s)) problems.push(`${id}: role ${rid} mcp server "${s}" uses \${VAR}s that no credential of the role provides`);
      }
    }
  }
  if (opts.denyFile) problems.push(...(await denylistHits(opts.denyFile, JSON.stringify(resolved.json) + "\n" + Object.values(resolved.prompts).join("\n"))));
  return problems;
}

async function denylistHits(file: string, text: string): Promise<string[]> {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const hit = line.startsWith("re:") ? new RegExp(line.slice(3), "i").test(text) : lower.includes(line.toLowerCase());
    if (hit) hits.push(`leak: deny-list entry "${line.length > 40 ? line.slice(0, 40) + "…" : line}" appears in the loaded config`);
  }
  return hits;
}
