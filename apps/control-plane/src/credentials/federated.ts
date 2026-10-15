import type { CredentialSpec } from "@ai-employee/core";
import type { CredentialProvider } from "./types.js";

type Spec = Extract<CredentialSpec, { kind: "federated" }>;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMES = ["AZURE_FEDERATED_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_FEDERATED_AUDIENCE"];

/**
 * kind `federated`, provider azure: no secret exists. The runner trades its own Google identity for an Azure session
 * (see apps/runner bootstrap), so the control plane only hands over ids. `exchange: control-plane` logins are used by
 * monitors, not sandboxes, and set nothing in a run.
 */
export const federatedProvider: CredentialProvider<Spec> = {
  kind: "federated",
  validate: (name, spec) => [
    ...(GUID.test(spec.tenantId) ? [] : [`credential "${name}": tenantId is not a GUID`]),
    ...(GUID.test(spec.clientId) ? [] : [`credential "${name}": clientId is not a GUID`]),
  ],
  envNames: (spec) => (spec.exchange === "runner" ? NAMES : []),
  async resolve(_name, spec) {
    if (spec.exchange !== "runner") return { env: {} };
    return {
      env: {
        AZURE_FEDERATED_CLIENT_ID: spec.clientId,
        AZURE_TENANT_ID: spec.tenantId,
        ...(spec.subscriptionId ? { AZURE_SUBSCRIPTION_ID: spec.subscriptionId } : {}),
        AZURE_FEDERATED_AUDIENCE: spec.audience,
      },
    };
  },
};
