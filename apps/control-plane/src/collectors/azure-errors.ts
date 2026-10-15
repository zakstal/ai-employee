import { z } from "zod";
import { collectAzureErrors, type AzureAuth, type AzureErrorsConfig } from "../monitors/azure.js";
import { type Monitor, type Employee } from "@ai-employee/core";
import type { Config } from "../config.js";
import type { SecretStore } from "../credentials/types.js";
import type { Collector } from "./types.js";

/** Azure sign-in for a monitor: the employee's named credential if the monitor has one, else the global AZURE_* env. */
export async function azureAuthFor(employee: Employee, monitor: Monitor, config: Config, secrets: SecretStore): Promise<AzureAuth> {
  if (!monitor.credential) {
    return {
      subscriptionId: config.AZURE_SUBSCRIPTION_ID,
      brokerUrl: config.AZURE_BROKER_URL || undefined,
      brokerSecret: config.AZURE_BROKER_SECRET || undefined,
      tenantId: config.AZURE_TENANT_ID || undefined,
      clientId: config.AZURE_CLIENT_ID || undefined,
      clientSecret: config.AZURE_CLIENT_SECRET || undefined,
    };
  }
  const spec = employee.credentials?.[monitor.credential];
  const subscriptionId = (spec && "subscriptionId" in spec && spec.subscriptionId) || config.AZURE_SUBSCRIPTION_ID;
  if (spec?.kind === "federated") return { subscriptionId, federated: { tenantId: spec.tenantId, clientId: spec.clientId, audience: spec.audience } };
  if (spec?.kind === "broker") {
    const brokerSecret = await secrets.get(spec.secret.secret);
    if (brokerSecret === undefined) throw new Error(`credential "${monitor.credential}": secret "${spec.secret.secret}" (broker key) has no value`);
    return { subscriptionId, brokerUrl: spec.url, brokerSecret };
  }
  throw new Error(`monitor credential "${monitor.credential}" must name a broker or federated credential of ${employee.id}`);
}

// Permissive on purpose: live configs that worked before the schema existed must keep working, so only the types the code reads are checked.
const schema = z
  .object({
    apps: z.array(z.object({ rg: z.string(), name: z.string() }).passthrough()).optional(),
    lookbackMin: z.number().optional(),
    minCount: z.number().optional(),
    minNew: z.number().optional(),
    spikeFactor: z.number().optional(),
    alerts: z.boolean().optional(),
    alertCooldownMin: z.number().optional(),
  })
  .passthrough();

export const azureErrors: Collector<z.infer<typeof schema>> = {
  id: "azure-errors",
  configSchema: schema,
  async collect(ctx, config, prev) {
    return collectAzureErrors(config as AzureErrorsConfig, await azureAuthFor(ctx.employee, ctx.monitor, ctx.config, ctx.secrets), prev, ctx.now);
  },
};
