import { createSign } from "node:crypto";
import type { CredentialSpec } from "@ai-employee/core";
import type { CredentialProvider } from "./types.js";

type Spec = Extract<CredentialSpec, { kind: "minted" }>;

const b64u = (b: Buffer) => b.toString("base64url");

/** RS256 JWT for the GitHub App (Node's crypto signs with a PEM, so no JWT library). */
export function appJwt(appId: string, pem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60; // clock skew allowance
  const head = b64u(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u(Buffer.from(JSON.stringify({ iat, exp: iat + 540, iss: appId }))); // GitHub allows 10 minutes at most
  return `${head}.${body}.${b64u(createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem))}`;
}

/**
 * kind `minted`, provider github-app: one installation access token per task, scoped to the spec's repositories
 * and permissions (a subset of what the app was granted). Tokens last exactly one hour and cannot be extended.
 */
export const githubAppProvider: CredentialProvider<Spec> = {
  kind: "minted",
  // permission values are already limited to read|write by the schema
  validate: (name, spec) => (spec.env.length ? [] : [`credential "${name}": env must name at least one variable`]),
  envNames: (spec) => [...spec.env, ...(spec.gitAuthor ? ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"] : [])],
  async resolve(name, spec, ctx) {
    const pem = await ctx.secrets.get(spec.privateKey.secret);
    if (pem === undefined) throw new Error(`credential "${name}": secret "${spec.privateKey.secret}" (GitHub App private key) has no value`);
    const res = await ctx.fetch(`https://api.github.com/app/installations/${spec.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(spec.appId, pem, ctx.now())}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...(spec.repositories ? { repositories: spec.repositories } : {}), permissions: spec.permissions }),
    });
    if (res.status !== 201) throw new Error(`credential "${name}": GitHub installation token request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
    const env = Object.fromEntries(spec.env.map((n) => [n, token]));
    if (spec.gitAuthor) Object.assign(env, { GIT_AUTHOR_NAME: spec.gitAuthor.name, GIT_AUTHOR_EMAIL: spec.gitAuthor.email });
    return { env, expiresAt: new Date(expires_at) };
  },
};
