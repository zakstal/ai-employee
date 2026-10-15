import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmployeeSchema, type Employee, type Role } from "@ai-employee/core";
import { loadConfig } from "../config.js";
import { appJwt } from "./github-app.js";
import { resolveGrantEnv, type CredentialContext } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const config = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x" } as NodeJS.ProcessEnv);
const NOW = new Date("2026-01-01T00:00:00Z");

const emp = (extra: object = {}) =>
  EmployeeSchema.parse({
    id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }],
    credentials: { gh: { kind: "minted", provider: "github-app", appId: "1000001", installationId: "42", privateKey: { secret: "key" }, permissions: { contents: "write", metadata: "read" }, repositories: ["a", "b"], ...extra } },
  });

function run(employee: Employee, reply: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  const ctx: CredentialContext = { employee, role: {} as Role, taskId: "t", config, secrets: { get: async () => privateKey }, fetch: fetchFake, now: () => NOW };
  return { calls, env: () => resolveGrantEnv(ctx, ["gh"]) };
}
const ok = { status: 201, body: { token: "ghs_tok", expires_at: "2026-01-01T01:00:00Z" } };

describe("github-app provider", () => {
  it("signs a JWT GitHub can verify", () => {
    const [h, b, sig] = appJwt("1000001", privateKey, NOW).split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(createPublicKey(publicKey), Buffer.from(sig!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(b!, "base64url").toString());
    expect(claims).toMatchObject({ iss: "1000001" });
    expect(claims.exp - claims.iat).toBe(540);
  });
  it("requests only the configured repositories and permissions", async () => {
    const r = run(emp(), ok);
    await r.env();
    expect(r.calls[0]!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({ repositories: ["a", "b"], permissions: { contents: "write", metadata: "read" } });
  });
  it("exports the token under every name in env, defaulting to GH_TOKEN and NPM_GITHUB_TOKEN", async () => {
    expect(await run(emp(), ok).env()).toEqual({ GH_TOKEN: "ghs_tok", NPM_GITHUB_TOKEN: "ghs_tok" });
    expect(await run(emp({ env: ["X"] }), ok).env()).toEqual({ X: "ghs_tok" });
  });
  it("sets the bot git identity", async () => {
    const env = await run(emp({ gitAuthor: { name: "bot[bot]", email: "1+bot[bot]@users.noreply.github.com" } }), ok).env();
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: "bot[bot]", GIT_AUTHOR_EMAIL: "1+bot[bot]@users.noreply.github.com" });
  });
  it("surfaces GitHub's 422 as a readable error", async () => {
    await expect(run(emp(), { status: 422, body: { message: "permissions not granted" } }).env()).rejects.toThrow(/\(422\).*permissions not granted/);
  });
  it("a missing private key throws, naming the secret", async () => {
    const e = emp();
    const ctx = { employee: e, role: {} as Role, taskId: "t", config, secrets: { get: async () => undefined }, fetch, now: () => NOW } as CredentialContext;
    await expect(resolveGrantEnv(ctx, ["gh"])).rejects.toThrow('secret "key"');
  });
});
