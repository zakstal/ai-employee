import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkConfig } from "./check.js";

const shipped = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../roles");

/** A one-employee dir whose first role is `r` with extra YAML lines appended to the role. */
async function cfg(extra = "", header = ""): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
  await writeFile(path.join(dir, "e.yaml"), `id: e\nname: E\ndefaultRole: r\n${header}roles:\n  - id: r\n${extra}`);
  return [dir];
}

describe("checkConfig", () => {
  it("passes on the shipped dev.yaml", async () => {
    expect(await checkConfig({ dirs: [shipped], managerRole: "manager" })).toEqual([]);
  });
  it("fails on a dangling canSpawn and names the role", async () => {
    expect(await checkConfig({ dirs: await cfg("    canSpawn: [ghost]\n") })).toEqual(['e: role r canSpawn names unknown role "ghost"']);
  });
  it("fails on a dangling workstream, monitor and manager role", async () => {
    const header = "workstreams: { w: { entryRole: nope } }\nmonitors: { m: { collector: azure-errors, role: nada } }\n";
    const p = await checkConfig({ dirs: await cfg("", header), managerRole: "boss" });
    expect(p).toHaveLength(3);
  });
  it("fails on an unknown credential grant", async () => {
    expect((await checkConfig({ dirs: await cfg("    credentials: [telepathy]\n") }))[0]).toMatch(/unknown credential grant "telepathy"/);
  });
  it("fails on an mcp placeholder no credential provides", async () => {
    const p = await checkConfig({ dirs: await cfg("    mcpServers:\n      s: { command: x, env: { K: '${SOME_TOKEN}' } }\n") });
    expect(p[0]).toMatch(/mcp server "s"/);
  });
  it("--public flags a deny-listed word in a prompt", async () => {
    const dirs = await cfg("    systemPrompt: contact Acme Corp\n");
    const deny = path.join(dirs[0]!, "deny.txt");
    await writeFile(deny, "# comment\nacme corp\n");
    expect((await checkConfig({ dirs, denyFile: deny }))[0]).toMatch(/deny-list entry "acme corp"/);
    expect(await checkConfig({ dirs })).toEqual([]);
  });
});

describe("checkConfig credentials", () => {
  const header = (creds: string) => `credentials:\n${creds}`;
  it("reports a provider's validation problem", async () => {
    const p = await checkConfig({ dirs: await cfg("    grants: [az]\n", header("  az: { kind: federated, provider: azure, tenantId: nope, clientId: nope }\n")) });
    expect(p).toEqual(['e: credential "az": tenantId is not a GUID', 'e: credential "az": clientId is not a GUID']);
  });
  it("reports two grants of one role that set the same env var", async () => {
    const creds = "  a: { kind: secret, env: { X: { value: '1' } } }\n  b: { kind: secret, env: { X: { value: '2' } } }\n";
    expect(await checkConfig({ dirs: await cfg("    grants: [a, b]\n", header(creds)) })).toEqual(['e: role r grants "a" and "b", which both set X']);
  });
});

describe("checkConfig schedules", () => {
  const sched = (s: string) => `schedules:\n  s: { ${s}, deliverTo: { channel: clickup, threadRef: t } }\n`;
  it("accepts a valid schedule", async () => {
    expect(await checkConfig({ dirs: await cfg("", sched("cron: '0 1 * * *', timezone: America/Los_Angeles, role: r, prompt: go")) })).toEqual([]);
  });
  it("rejects a bad cron, a bad timezone, a too-frequent cron and an unknown role", async () => {
    expect((await checkConfig({ dirs: await cfg("", sched("cron: 'nope', role: r, prompt: go")) }))[0]).toMatch(/schedule s:/);
    expect((await checkConfig({ dirs: await cfg("", sched("cron: '0 1 * * *', timezone: Mars/Base, role: r, prompt: go")) }))[0]).toMatch(/schedule s:/);
    expect((await checkConfig({ dirs: await cfg("", sched("cron: '* * * * *', role: r, prompt: go")) }))[0]).toMatch(/15 minutes/);
    expect((await checkConfig({ dirs: await cfg("", sched("cron: '0 1 * * *', role: ghost, prompt: go")) }))[0]).toMatch(/unknown role "ghost"/);
  });
  it("needs exactly one of prompt / promptFile", async () => {
    expect((await checkConfig({ dirs: await cfg("", sched("cron: '0 1 * * *', role: r")) }))[0]).toMatch(/exactly one of prompt or promptFile/);
  });
});
