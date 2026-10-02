import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { EmployeeSchema, type Employee } from "@ai-employee/core";

/** One YAML file per employee in `dir`. Fails loudly at boot on any invalid file. */
export async function loadEmployees(dir: string): Promise<Map<string, Employee>> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const out = new Map<string, Employee>();
  for (const f of files) {
    const raw = parse(await readFile(path.join(dir, f), "utf8"));
    const parsed = EmployeeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid employee config ${f}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    if (out.has(parsed.data.id)) throw new Error(`duplicate employee id ${parsed.data.id} in ${f}`);
    for (const role of parsed.data.roles) {
      if (role.systemPromptFile) {
        const promptPath = path.resolve(dir, role.systemPromptFile);
        if (!promptPath.startsWith(path.resolve(dir))) throw new Error(`role ${role.id}: systemPromptFile escapes ${dir}`);
        role.systemPrompt = await readFile(promptPath, "utf8");
      }
    }
    out.set(parsed.data.id, parsed.data);
  }
  if (out.size === 0) throw new Error(`no employee configs found in ${dir}`);
  return out;
}
