import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkConfig } from "./check.js";
import { resolveEffectiveConfig } from "./resolve.js";

const USAGE = `usage: config resolve [--dir <config dir>]... [--out <dir>] [--prompts full] [--sandbox-runtime k8s|local|cloudrun|warm]
                      [--manager-role <id>] [--live-env-names <file>] [--env KEY=VALUE]...
       config check   [--dir <config dir>]... [--manager-role <id>] [--sandbox-runtime ...] [--public --deny-file <file>]
--env sets a non-secret control-plane setting for the dump (RUNNER_IMAGES, CLOUDRUN_JOB_PREFIX, ...), repeatable.
resolve prints the effective configuration as JSON (no secret values). With --out, it writes config.json
(and prompts/<employee>.<role>.md with --prompts full) instead.
check validates the config (schema, prompt files, extends, role references, MCP credentials) and exits 1 on any
problem. With --public it also scans everything loaded against a deny list (plain words or "re:<regex>" lines).`;

async function main(): Promise<void> {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string", multiple: true },
      out: { type: "string" },
      prompts: { type: "string" },
      "sandbox-runtime": { type: "string" },
      "manager-role": { type: "string" },
      "live-env-names": { type: "string" },
      env: { type: "string", multiple: true },
      public: { type: "boolean" },
      "deny-file": { type: "string" },
    },
  });
  const cmd = positionals[0];
  if (cmd !== "resolve" && cmd !== "check") {
    console.error(USAGE);
    process.exit(2);
  }
  const liveEnvNames = v["live-env-names"] ? (await readFile(v["live-env-names"], "utf8")).split(/\s+/).filter(Boolean) : undefined;
  const opts = {
    dirs: (v.dir?.length ? v.dir : [process.env.ROLES_DIR ?? "roles"]).map((d) => path.resolve(d)),
    liveEnvNames,
    sandboxRuntime: v["sandbox-runtime"] as never,
    managerRole: v["manager-role"],
    env: Object.fromEntries((v.env ?? []).map((kv) => {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error(`--env needs KEY=VALUE, got "${kv}"`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    })),
  };
  if (cmd === "check") {
    if (v.public && !v["deny-file"]) throw new Error("--public needs --deny-file");
    const problems = await checkConfig({ ...opts, denyFile: v.public ? v["deny-file"] : undefined });
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    return void console.log("config ok");
  }
  const { json, prompts } = await resolveEffectiveConfig(opts);
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
