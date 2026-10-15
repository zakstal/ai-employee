import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { EmployeeSchema, type Employee } from "@ai-employee/core";
import { resolveRoles, substitute } from "./merge.js";

/** Employee files of one dir: `<dir>/employees/*.y?ml` when that folder exists, else `<dir>/*.y?ml`. */
async function employeeFiles(dir: string): Promise<string[]> {
  const sub = path.join(dir, "employees");
  const base = existsSync(sub) ? sub : dir;
  return (await readdir(base)).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(base, f));
}

/** First dir that holds `rel`. A path that leaves its dir is an error, never a fallthrough. */
async function resolvePrompt(dirs: string[], rel: string, roleId: string): Promise<string> {
  for (const dir of dirs) {
    const p = path.resolve(dir, rel);
    const up = path.relative(dir, p);
    if (up.startsWith("..") || path.isAbsolute(up)) throw new Error(`role ${roleId}: systemPromptFile escapes ${dir}`);
    if (existsSync(p)) return readFile(p, "utf8");
  }
  throw new Error(`role ${roleId}: systemPromptFile ${rel} not found in ${dirs.join(", ")}`);
}

type Raw = Record<string, unknown>;
const asMap = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});

async function readYaml(file: string, what: string): Promise<Raw> {
  try {
    return asMap(parse(await readFile(file, "utf8")));
  } catch (e) {
    throw new Error(`${what} ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * `include:` fragments (paths relative to the file) and `use:` bundles (`<dir>/bundles/<name>.yaml`, first dir
 * wins) both carry `roles`, `workstreams`, `monitors`. Fragments merge into the file (a duplicate id is an error);
 * bundles sit below it, so the file's own definitions win. Then roles resolve `extends`.
 */
async function expand(raw: Raw, file: string, dirs: string[]): Promise<Raw> {
  const own = [...((raw.roles as Raw[] | undefined) ?? [])];
  const maps = { workstreams: { ...asMap(raw.workstreams) }, monitors: { ...asMap(raw.monitors) } };
  for (const inc of (raw.include as string[] | undefined) ?? []) {
    const frag = await readYaml(path.resolve(path.dirname(file), inc), "include");
    for (const r of (frag.roles as Raw[] | undefined) ?? []) {
      if (own.some((o) => o.id === r.id)) throw new Error(`include ${inc}: duplicate role ${String(r.id)}`);
      own.push(r);
    }
    for (const m of ["workstreams", "monitors"] as const) {
      for (const [k, v] of Object.entries(asMap(frag[m]))) {
        if (k in maps[m]) throw new Error(`include ${inc}: duplicate ${m} entry ${k}`);
        maps[m][k] = v;
      }
    }
  }
  const baseRoles: Raw[] = [];
  const below = { workstreams: {} as Raw, monitors: {} as Raw };
  for (const name of (raw.use as string[] | undefined) ?? []) {
    const bf = dirs.map((d) => path.join(d, "bundles", `${name}.yaml`)).find(existsSync);
    if (!bf) throw new Error(`use ${name}: bundles/${name}.yaml not found in ${dirs.join(", ")}`);
    const bundle = await readYaml(bf, "bundle");
    baseRoles.push(...((bundle.roles as Raw[] | undefined) ?? []));
    Object.assign(below.workstreams, asMap(bundle.workstreams));
    Object.assign(below.monitors, asMap(bundle.monitors));
  }
  return {
    ...raw,
    include: undefined,
    use: undefined,
    roles: resolveRoles(own, baseRoles),
    workstreams: { ...below.workstreams, ...maps.workstreams },
    monitors: { ...below.monitors, ...maps.monitors },
  };
}

/**
 * One YAML file per employee. `dirs` is ordered, instance dir first: a file name seen in an earlier dir
 * shadows the same name in a later one, and prompt files resolve in the first dir that has them.
 * Fails loudly at boot on any invalid file.
 */
export async function loadEmployees(dirs: string | string[]): Promise<Map<string, Employee>> {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.resolve(d));
  const out = new Map<string, Employee>();
  const seen = new Set<string>();
  for (const dir of list) {
    for (const file of await employeeFiles(dir)) {
      const f = path.basename(file);
      if (seen.has(f)) continue;
      seen.add(f);
      const parsed = EmployeeSchema.safeParse(await expand(await readYaml(file, "employee config"), file, list));
      if (!parsed.success) {
        throw new Error(`invalid employee config ${f}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      }
      if (out.has(parsed.data.id)) throw new Error(`duplicate employee id ${parsed.data.id} in ${f}`);
      const vars: Record<string, string> = { BOT_NAME: parsed.data.name, EMPLOYEE_ID: parsed.data.id, ...parsed.data.vars };
      vars.PR_SIGNATURE ??= `🤖 Created by ${vars.BOT_NAME}`;
      for (const role of parsed.data.roles) {
        const files = role.systemPromptFiles ?? (role.systemPromptFile ? [role.systemPromptFile] : []);
        if (files.length) role.systemPrompt = (await Promise.all(files.map((f) => resolvePrompt(list, f, role.id)))).join("\n\n");
        role.systemPrompt = substitute(role.systemPrompt, vars, role.id);
      }
      out.set(parsed.data.id, parsed.data);
    }
  }
  if (out.size === 0) throw new Error(`no employee configs found in ${list.join(", ")}`);
  return out;
}
