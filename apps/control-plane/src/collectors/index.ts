import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { azureErrors } from "./azure-errors.js";
import { clickupChannels } from "./clickup-channels.js";
import { clickupTaskStatus } from "./clickup-task-status.js";
import { gitBranches } from "./git-branches.js";
import { githubChecks } from "./github-checks.js";
import { githubPrs } from "./github-prs.js";
import type { Collector } from "./types.js";

export type { CollectContext, Collector } from "./types.js";

export const BUILTIN_COLLECTORS: Collector<never>[] = [azureErrors, clickupChannels, githubPrs, githubChecks, clickupTaskStatus, gitBranches] as Collector<never>[];
const registry = new Map<string, Collector<never>>(BUILTIN_COLLECTORS.map((c) => [c.id, c]));

const loadedFiles = new Map<string, string>(); // plugin file -> collector id, so loading the same dir twice is a no-op

export const getCollector = (id: string): Collector<never> | undefined => registry.get(id);
export const collectorIds = (): string[] => [...registry.keys()].sort();

const isCollector = (x: unknown): x is Collector<never> =>
  !!x && typeof x === "object" && typeof (x as Collector).id === "string" && typeof (x as Collector).collect === "function" && typeof (x as Collector).configSchema?.safeParse === "function" && typeof (x as Collector).configSchema?.parse === "function";

/**
 * Plugin collectors: every `<dir>/collectors/*.mjs` of the config dirs, default export a Collector. They run inside the
 * control plane with its privileges, so they come from the config repo's image, never from a task. A plugin that cannot be
 * imported, is not a Collector, or reuses an id is reported and skipped (a monitor that names it then fails validation).
 */
export async function loadPlugins(dirs: string[]): Promise<{ loaded: string[]; errors: string[] }> {
  const loaded: string[] = [];
  const errors: string[] = [];
  for (const dir of dirs) {
    const sub = path.resolve(dir, "collectors");
    if (!existsSync(sub)) continue;
    for (const f of (await readdir(sub)).filter((n) => n.endsWith(".mjs")).sort()) {
      const file = path.join(sub, f);
      if (loadedFiles.has(file)) {
        loaded.push(loadedFiles.get(file)!);
        continue;
      }
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
        if (!isCollector(mod.default)) throw new Error("default export is not a Collector {id, configSchema, collect}");
        if (registry.has(mod.default.id)) throw new Error(`id "${mod.default.id}" is already registered`);
        registry.set(mod.default.id, mod.default);
        loadedFiles.set(file, mod.default.id);
        loaded.push(mod.default.id);
      } catch (e) {
        errors.push(`collector plugin ${file}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return { loaded, errors };
}

/** Every monitor must name a known collector and carry a config it accepts. */
export function monitorProblems(employees: Iterable<{ id: string; monitors: Record<string, { collector: string; config: unknown }> }>): string[] {
  const out: string[] = [];
  for (const e of employees) {
    for (const [name, m] of Object.entries(e.monitors)) {
      const c = registry.get(m.collector);
      if (!c) {
        out.push(`${e.id}: monitor ${name} names unknown collector "${m.collector}" (known: ${collectorIds().join(", ")})`);
        continue;
      }
      const r = c.configSchema.safeParse(m.config);
      if (!r.success) out.push(`${e.id}: monitor ${name} config for ${m.collector}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
  }
  return out;
}
