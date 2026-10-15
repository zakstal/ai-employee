import type { CredentialSpec } from "@ai-employee/core";
import type { CredentialProvider } from "./types.js";

type Spec = Extract<CredentialSpec, { kind: "secret" }>;

/** kind `secret`: env vars from inline values or Secret Manager references. */
export const secretProvider: CredentialProvider<Spec> = {
  kind: "secret",
  validate: (name, spec) => (Object.keys(spec.env).length ? [] : [`credential "${name}": secret login sets no env vars`]),
  envNames: (spec) => Object.keys(spec.env),
  async resolve(name, spec, ctx) {
    const env: Record<string, string> = {};
    for (const [k, ref] of Object.entries(spec.env)) {
      if ("value" in ref) {
        env[k] = ref.value;
        continue;
      }
      const v = await ctx.secrets.get(ref.secret);
      if (v === undefined) {
        if (ref.optional) continue;
        throw new Error(`credential "${name}": secret "${ref.secret}" has no value (env ${k})`);
      }
      env[k] = v;
    }
    return { env };
  },
};
