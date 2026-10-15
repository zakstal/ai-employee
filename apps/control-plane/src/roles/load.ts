import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { EmployeeSchema, type Employee } from "@ai-employee/core";

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
      const parsed = EmployeeSchema.safeParse(parse(await readFile(file, "utf8")));
      if (!parsed.success) {
        throw new Error(`invalid employee config ${f}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      }
      if (out.has(parsed.data.id)) throw new Error(`duplicate employee id ${parsed.data.id} in ${f}`);
      for (const role of parsed.data.roles) {
        if (role.systemPromptFile) role.systemPrompt = await resolvePrompt(list, role.systemPromptFile, role.id);
      }
      out.set(parsed.data.id, parsed.data);
    }
  }
  if (out.size === 0) throw new Error(`no employee configs found in ${list.join(", ")}`);
  return out;
}
