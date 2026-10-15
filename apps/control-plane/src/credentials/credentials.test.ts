import { describe, expect, it } from "vitest";
import { CredentialSpecSchema, EmployeeSchema, roleGrants, type Employee, type Role } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { environmentFooter } from "../orchestration/steps.js";
import { grantEnvNames, grantPurposes, legacyEnv, resolveGrantEnv, type CredentialContext } from "./index.js";

const config = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", GH_TOKEN: "ghp_x" } as NodeJS.ProcessEnv);
const role = (r: Partial<Role>) => ({ id: "r", allowedTools: [], credentials: [], repos: [], capabilities: [], ...r }) as unknown as Role;
const ctx = (employee?: Employee, secrets: Record<string, string> = {}): CredentialContext => ({ employee: employee ?? ({ id: "e" } as Employee), role: role({}), taskId: "t", config, secrets: { get: async (n) => secrets[n] }, fetch, now: () => new Date() });

describe("legacy grants", () => {
  it("github sets GH_TOKEN and NPM_GITHUB_TOKEN", () => {
    expect(legacyEnv("github", config)).toEqual({ GH_TOKEN: "ghp_x", NPM_GITHUB_TOKEN: "ghp_x" });
  });
  it("an unknown grant throws the existing message", async () => {
    expect(() => legacyEnv("telepathy", config)).toThrow('unknown credential grant "telepathy"');
    await expect(resolveGrantEnv(ctx(), ["telepathy"])).rejects.toThrow('unknown credential grant "telepathy"');
  });
  it("resolveGrantEnv falls back to the built-ins when the employee defines nothing", async () => {
    expect(await resolveGrantEnv(ctx(), ["github"])).toEqual({ GH_TOKEN: "ghp_x", NPM_GITHUB_TOKEN: "ghp_x" });
  });
});

describe("grants", () => {
  it("role.credentials is read as grants; grants wins when present", () => {
    expect(roleGrants({ credentials: ["github"] })).toEqual(["github"]);
    expect(roleGrants({ credentials: ["github"], grants: ["clickup"] })).toEqual(["clickup"]);
  });
  it("an employee file parses a credentials map of every kind", () => {
    const e = EmployeeSchema.parse({
      id: "e", name: "E", defaultRole: "r", roles: [{ id: "r", grants: ["a"] }],
      credentials: {
        a: { kind: "secret", env: { X: { secret: "x" }, Y: { value: "1" } } },
        b: { kind: "minted", provider: "github-app", appId: "1", installationId: "2", privateKey: { secret: "k" }, permissions: { contents: "write" } },
        c: { kind: "federated", provider: "azure", tenantId: "t", clientId: "c" },
        d: { kind: "broker", provider: "azure", url: "http://b", secret: { secret: "s" } },
      },
    });
    expect(e.credentials?.b).toMatchObject({ env: ["GH_TOKEN", "NPM_GITHUB_TOKEN"] });
    expect(e.credentials?.c).toMatchObject({ audience: "api://AzureADTokenExchange", exchange: "runner" });
  });
  it("rejects a value in place of a reference kind", () => {
    expect(() => CredentialSpecSchema.parse({ kind: "nope" })).toThrow();
  });
});

describe("purpose", () => {
  const emp = EmployeeSchema.parse({
    id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }],
    credentials: { cloud: { kind: "federated", provider: "azure", tenantId: "t", clientId: "c" }, pm: { kind: "secret", for: "clickup", env: {} }, github: { kind: "secret", env: {} } },
  });
  it("comes from `for`, the kind, or the built-in name; an employee login shadows a built-in name", () => {
    expect([...grantPurposes(emp, role({ grants: ["cloud", "pm"] }))].sort()).toEqual(["azure", "clickup"]);
    expect([...grantPurposes(undefined, role({ credentials: ["github", "azure-user"] }))].sort()).toEqual(["azure", "github"]);
    expect([...grantPurposes(emp, role({ grants: ["github"] }))]).toEqual(["other"]);
  });
  it("drives the footer, so renaming a grant keeps the lines", () => {
    const f = environmentFooter(role({ grants: ["cloud", "pm"] }), emp);
    expect(f).toContain("ALREADY LOGGED IN");
    expect(f).toContain("mcp__clickup__*");
    expect(f).not.toContain("gh pr create");
  });
});

describe("secret provider", () => {
  const emp = (env: object) => EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }], credentials: { pm: { kind: "secret", env } } });
  it("passes inline values through and reads references from the store", async () => {
    const e = emp({ TOKEN: { secret: "t" }, TEAM: { value: "42" } });
    expect(await resolveGrantEnv(ctx(e, { t: "abc" }), ["pm"])).toEqual({ TOKEN: "abc", TEAM: "42" });
    expect(grantEnvNames(e, role({ grants: ["pm"] }), config)).toEqual(["TEAM", "TOKEN"]);
  });
  it("a secret with no version throws unless optional", async () => {
    await expect(resolveGrantEnv(ctx(emp({ TOKEN: { secret: "t" } })), ["pm"])).rejects.toThrow('secret "t" has no value');
    expect(await resolveGrantEnv(ctx(emp({ TOKEN: { secret: "t", optional: true } })), ["pm"])).toEqual({});
  });
  it("an employee login of a built-in name wins over the built-in", async () => {
    const e = EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }], credentials: { github: { kind: "secret", env: { GH_TOKEN: { value: "mine" } } } } });
    expect(await resolveGrantEnv(ctx(e), ["github"])).toEqual({ GH_TOKEN: "mine" });
  });
});
