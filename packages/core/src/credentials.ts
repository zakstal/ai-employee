import { z } from "zod";

/** What a login is for. Drives the environment footer and `config check`; inferred for minted/federated/broker kinds. */
export const PurposeSchema = z.enum(["azure", "github", "clickup", "claude", "other"]);
export type Purpose = z.infer<typeof PurposeSchema>;

const SecretRef = z.object({ secret: z.string().min(1) });

/**
 * A named login of one employee and how to obtain it. Values never appear here: they are secret names,
 * ids, or nothing at all (federation). Roles list the names they may use as `grants`.
 */
export const CredentialSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("secret"),
    for: PurposeSchema.optional(),
    /** env var -> secret reference, or an inline non-secret value. `optional` skips a secret with no version. */
    env: z.record(z.union([SecretRef.extend({ optional: z.boolean().optional() }), z.object({ value: z.string() })])),
  }),
  z.object({
    kind: z.literal("minted"),
    provider: z.literal("github-app"),
    for: PurposeSchema.optional(),
    appId: z.string().min(1),
    installationId: z.string().min(1),
    privateKey: SecretRef,
    permissions: z.record(z.enum(["read", "write"])),
    /** Narrows the token below the installation's repositories. */
    repositories: z.array(z.string()).optional(),
    /** Env var names the token is exported as. */
    env: z.array(z.string().min(1)).default(["GH_TOKEN", "NPM_GITHUB_TOKEN"]),
    gitAuthor: z.object({ name: z.string(), email: z.string() }).optional(),
  }),
  z.object({
    kind: z.literal("federated"),
    provider: z.literal("azure"),
    for: PurposeSchema.optional(),
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
    subscriptionId: z.string().optional(),
    audience: z.string().min(1).default("api://AzureADTokenExchange"),
    /** runner: the sandbox's own Google identity is exchanged. control-plane: monitors only. */
    exchange: z.enum(["runner", "control-plane"]).default("runner"),
  }),
  z.object({
    kind: z.literal("broker"),
    provider: z.literal("azure"),
    for: PurposeSchema.optional(),
    url: z.string().min(1),
    secret: SecretRef,
    tenantId: z.string().optional(),
    subscriptionId: z.string().optional(),
  }),
]);
export type CredentialSpec = z.infer<typeof CredentialSpecSchema>;
