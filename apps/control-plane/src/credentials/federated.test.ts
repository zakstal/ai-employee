import { describe, expect, it } from "vitest";
import { EmployeeSchema, type Role } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { resolveImage } from "../orchestration/steps.js";
import { federatedProvider } from "./federated.js";
import { grantEnvNames, resolveGrantEnv, type CredentialContext } from "./index.js";

const config = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", RUNNER_IMAGES: '{"runner-ops":"ops:1"}' } as NodeJS.ProcessEnv);
const T = "00000000-0000-0000-0000-000000000000";
const C = "11111111-1111-1111-1111-111111111111";
const emp = (extra: object = {}) =>
  EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r", grants: ["az"] }], credentials: { az: { kind: "federated", provider: "azure", tenantId: T, clientId: C, subscriptionId: "sub", ...extra } } });
const role = { grants: ["az"], credentials: [] } as unknown as Role;
const ctx = (e: ReturnType<typeof emp>): CredentialContext => ({ employee: e, role, taskId: "t", config, secrets: { get: async () => undefined }, fetch, now: () => new Date() });

describe("federated provider", () => {
  it("hands the runner ids only, nothing secret, and no network", async () => {
    expect(await resolveGrantEnv(ctx(emp()), ["az"])).toEqual({ AZURE_FEDERATED_CLIENT_ID: C, AZURE_TENANT_ID: T, AZURE_SUBSCRIPTION_ID: "sub", AZURE_FEDERATED_AUDIENCE: "api://AzureADTokenExchange" });
    expect(grantEnvNames(emp(), role, config)).toEqual(["AZURE_FEDERATED_AUDIENCE", "AZURE_FEDERATED_CLIENT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_TENANT_ID"]);
  });
  it("exchange control-plane sets nothing in a run", async () => {
    expect(await resolveGrantEnv(ctx(emp({ exchange: "control-plane" })), ["az"])).toEqual({});
  });
  it("validate flags ids that are not GUIDs", () => {
    const spec = emp({ clientId: "nope" }).credentials!.az as never;
    expect(federatedProvider.validate("az", spec)).toEqual(['credential "az": clientId is not a GUID']);
    expect(federatedProvider.validate("az", emp().credentials!.az as never)).toEqual([]);
  });
});

describe("per-employee Cloud Run job prefix", () => {
  const r = { imageRef: "runner-ops" } as Role;
  it("replaces CLOUDRUN_JOB_PREFIX for imageRef roles only when the employee sets it", () => {
    expect(resolveImage(r, config)).toEqual({ image: "ops:1", jobName: "ai-employee-runner-ops" });
    expect(resolveImage(r, config, EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }], sandbox: { jobPrefix: "acme" } }))).toEqual({ image: "ops:1", jobName: "acme-runner-ops" });
  });
});
