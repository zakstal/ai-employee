import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveEffectiveConfig } from "./resolve.js";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../roles");
type Roles = Record<string, { credentialEnvNames: string[]; cloudRunJob: string | null }>;
const rolesOf = (j: Record<string, unknown>) => (j.employees as { dev: { roles: Roles } }).dev.roles;

describe("resolveEffectiveConfig", () => {
  it("dumps every role of the shipped dev.yaml", async () => {
    const { json, prompts } = await resolveEffectiveConfig({ dirs: [dir], sandboxRuntime: "warm" });
    const roles = rolesOf(json);
    expect(Object.keys(roles)).toHaveLength(Object.keys(prompts).length);
    expect(roles.implement!.cloudRunJob).toBe("ai-employee-runner-ops");
  });
  it("never contains a secret value", async () => {
    const { json } = await resolveEffectiveConfig({ dirs: [dir] });
    const text = JSON.stringify(json);
    expect(text).toContain("CLICKUP_API_TOKEN");
    expect(text).not.toContain("SECRET-SENTINEL-VALUE"); // the sentinel used for credential values
  });
  it("is deterministic", async () => {
    const a = await resolveEffectiveConfig({ dirs: [dir] });
    const b = await resolveEffectiveConfig({ dirs: [dir] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("sentinel vs live names", async () => {
    const { json } = await resolveEffectiveConfig({ dirs: [dir], liveEnvNames: ["GH_TOKEN"] });
    const names = rolesOf(json).implement!.credentialEnvNames;
    expect(names).toContain("GH_TOKEN");
    expect(names).not.toContain("CLICKUP_API_TOKEN");
  });
  it("--env settings reach the dump (RUNNER_IMAGES picks an imageRef role's image and job)", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "resolve-env-"));
    await writeFile(path.join(d, "e.yaml"), "id: e\nname: E\ndefaultRole: r\nroles:\n  - { id: r, imageRef: runner-ops, runtime: cloudrun }\n");
    const env = { RUNNER_IMAGES: '{"runner-ops":"reg/runner-ops:1"}', CLOUDRUN_JOB_PREFIX: "acme" };
    const { json } = await resolveEffectiveConfig({ dirs: [d], sandboxRuntime: "warm", env });
    const r = (json.employees as { e: { roles: Record<string, { imageResolved: string; cloudRunJob: string }> } }).e.roles.r!;
    expect(r.imageResolved).toBe("reg/runner-ops:1");
    expect(r.cloudRunJob).toBe("acme-runner-ops");
  });
});

describe("schedules in the resolved config", () => {
  const yaml = "id: e\nname: E\ndefaultRole: r\nroles:\n  - { id: r }\nschedules:\n  nightly: { cron: '0 1 * * *', timezone: America/Los_Angeles, role: r, prompt: go, deliverTo: { channel: clickup-chat, threadRef: t } }\n";
  it("lists config schedules and, with a live url, only the runtime ones", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "resolve-sch-"));
    await writeFile(path.join(d, "e.yaml"), yaml);
    const live = [
      { name: "nightly", cron: "0 1 * * *", timezone: "America/Los_Angeles", role_id: "r", enabled: true, next_fire_at: "x", source: "config" },
      { name: "mine", cron: "0 9 * * *", timezone: "UTC", role_id: "r", enabled: true, next_fire_at: "y", source: "runtime" },
    ];
    const fakeFetch = (async () => new Response(JSON.stringify(live))) as unknown as typeof fetch;
    const { json } = await resolveEffectiveConfig({ dirs: [d], liveUrl: "http://cp", fetch: fakeFetch });
    const e = (json.employees as Record<string, { schedulesInConfig: Record<string, { cron: string }>; schedulesRuntime: { name: string }[] }>).e!;
    expect(e.schedulesInConfig.nightly!.cron).toBe("0 1 * * *");
    expect(e.schedulesRuntime.map((s) => s.name)).toEqual(["mine"]);
  });
  it("is absent when the employee has none", async () => {
    const { json } = await resolveEffectiveConfig({ dirs: [dir] });
    expect(JSON.stringify(json)).not.toContain("schedulesInConfig");
  });
});
