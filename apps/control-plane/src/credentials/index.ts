import type { CredentialSpec, Employee, Purpose, Role } from "@ai-employee/core";
import { roleGrants } from "@ai-employee/core";
import type { Config } from "../config.js";
import { legacyEnv } from "./legacy.js";
import { brokerProvider } from "./broker.js";
import { federatedProvider } from "./federated.js";
import { githubAppProvider } from "./github-app.js";
import { secretProvider } from "./secret.js";
import type { CredentialContext, CredentialProvider } from "./types.js";

export * from "./types.js";
export { EnvSecretStore, GcpSecretStore } from "./secret-store.js";
export { isBuiltinGrant, legacyEnv } from "./legacy.js";

/** kind -> provider. Providers import only `types.ts`, so this file can list them without a cycle. */
const providers = new Map<string, CredentialProvider>(
  ([secretProvider, githubAppProvider, federatedProvider, brokerProvider] as unknown as CredentialProvider[]).map((p) => [p.kind, p]),
);
export function providerFor(spec: CredentialSpec): CredentialProvider {
  const p = providers.get(spec.kind);
  if (!p) throw new Error(`no credential provider for kind "${spec.kind}"`);
  return p;
}

/** Env for the given grants: the employee's own login of that name, else the built-in one (which throws on an unknown name). */
export async function resolveGrantEnv(ctx: CredentialContext, grants: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const g of grants) {
    const spec = ctx.employee.credentials?.[g];
    Object.assign(out, spec ? (await providerFor(spec).resolve(g, spec, ctx)).env : legacyEnv(g, ctx.config));
  }
  return out;
}

/** Same lookup without network or secrets: which env names each grant would set. Built-ins read `config` (a sentinel config in `config resolve`). */
export function grantEnvNames(employee: Employee, role: Role, config: Config): string[] {
  const names = new Set<string>();
  for (const g of roleGrants(role)) {
    const spec = employee.credentials?.[g];
    for (const n of spec ? providerFor(spec).envNames(spec) : Object.keys(legacyEnv(g, config))) names.add(n);
  }
  return [...names].sort();
}

const LEGACY_PURPOSE: Record<string, Purpose> = { anthropic: "claude", "claude-subscription": "claude", clickup: "clickup", github: "github", azure: "azure", "azure-user": "azure" };

/** What the role's logins are for: a login's `for`, inferred from its kind, or the built-in grant's name. */
export function grantPurposes(employee: Employee | undefined, role: Role): Set<Purpose> {
  const out = new Set<Purpose>();
  for (const g of roleGrants(role)) {
    const spec = employee?.credentials?.[g];
    if (!spec) {
      const p = LEGACY_PURPOSE[g];
      if (p) out.add(p);
    } else out.add(spec.for ?? (spec.kind === "minted" ? "github" : spec.kind === "secret" ? "other" : "azure"));
  }
  return out;
}

/** The role's grant that a running sandbox can refresh (a minted token that outlives a long run), if any. */
export function refreshableGrant(employee: Employee, role: Role): string | undefined {
  return roleGrants(role).find((g) => {
    const spec = employee.credentials?.[g];
    return spec && providerFor(spec).refreshable;
  });
}
