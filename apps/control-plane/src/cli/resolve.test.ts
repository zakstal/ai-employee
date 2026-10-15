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
});
