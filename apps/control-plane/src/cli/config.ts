import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveEffectiveConfig } from "./resolve.js";

const USAGE = `usage: config resolve [--dir <roles dir>] [--out <dir>] [--prompts full] [--sandbox-runtime k8s|local|cloudrun|warm]
                      [--manager-role <id>] [--live-env-names <file>]
Prints the effective configuration as JSON (no secret values). With --out, writes config.json
(and prompts/<employee>.<role>.md with --prompts full) instead.`;

async function main(): Promise<void> {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string", default: process.env.ROLES_DIR ?? "roles" },
      out: { type: "string" },
      prompts: { type: "string" },
      "sandbox-runtime": { type: "string" },
      "manager-role": { type: "string" },
      "live-env-names": { type: "string" },
    },
  });
  if (positionals[0] !== "resolve") {
    console.error(USAGE);
    process.exit(2);
  }
  const liveEnvNames = v["live-env-names"] ? (await readFile(v["live-env-names"], "utf8")).split(/\s+/).filter(Boolean) : undefined;
  const { json, prompts } = await resolveEffectiveConfig({
    dir: path.resolve(v.dir),
    liveEnvNames,
    sandboxRuntime: v["sandbox-runtime"] as never,
    managerRole: v["manager-role"],
  });
  const text = JSON.stringify(json, null, 2) + "\n";
  if (!v.out) return void process.stdout.write(text);
  await mkdir(path.join(v.out, "prompts"), { recursive: true });
  await writeFile(path.join(v.out, "config.json"), text);
  if (v.prompts === "full") for (const [k, p] of Object.entries(prompts)) await writeFile(path.join(v.out, "prompts", `${k}.md`), p);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
