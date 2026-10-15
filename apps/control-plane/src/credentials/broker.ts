import type { CredentialSpec } from "@ai-employee/core";
import type { CredentialProvider } from "./types.js";

type Spec = Extract<CredentialSpec, { kind: "broker" }>;

/**
 * kind `broker`, provider azure: a person's delegated login held by the token broker (infra/azbroker). The runner does
 * `az login --identity` against it using the App Service managed-identity variables. `secret` is this employee's key.
 */
export const brokerProvider: CredentialProvider<Spec> = {
  kind: "broker",
  validate: (name, spec) => (/^https?:\/\//.test(spec.url) ? [] : [`credential "${name}": url must start with http:// or https://`]),
  envNames: (spec) => ["IDENTITY_ENDPOINT", "IDENTITY_HEADER", "MSI_ENDPOINT", "MSI_SECRET", ...(spec.tenantId ? ["AZURE_TENANT_ID"] : []), ...(spec.subscriptionId ? ["AZURE_SUBSCRIPTION_ID"] : [])],
  async resolve(name, spec, ctx) {
    const key = await ctx.secrets.get(spec.secret.secret);
    if (key === undefined) throw new Error(`credential "${name}": secret "${spec.secret.secret}" (broker key) has no value`);
    const endpoint = `${spec.url}/token`;
    return {
      env: {
        IDENTITY_ENDPOINT: endpoint,
        IDENTITY_HEADER: key,
        MSI_ENDPOINT: endpoint,
        MSI_SECRET: key,
        ...(spec.tenantId ? { AZURE_TENANT_ID: spec.tenantId } : {}),
        ...(spec.subscriptionId ? { AZURE_SUBSCRIPTION_ID: spec.subscriptionId } : {}),
      },
    };
  },
};
