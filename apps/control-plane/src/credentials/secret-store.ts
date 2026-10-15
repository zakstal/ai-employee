import type { SecretStore } from "./types.js";

const CACHE_MS = 60_000;

/** Secret Manager over REST (no gRPC dependency). The caller's service account needs secretAccessor on each secret. */
export class GcpSecretStore implements SecretStore {
  private tok?: { v: string; exp: number };
  private cache = new Map<string, { v: string | undefined; exp: number }>();
  constructor(private project: string, private f: typeof fetch = fetch) {}

  private async token(): Promise<string> {
    if (this.tok && this.tok.exp > Date.now() + 60_000) return this.tok.v;
    const r = await this.f("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error(`metadata token ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.tok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  /** Latest version, cached for 60s: a task burst is one API call per secret and a rotation lands within a minute. */
  async get(name: string): Promise<string | undefined> {
    const hit = this.cache.get(name);
    if (hit && hit.exp > Date.now()) return hit.v;
    const url = `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets/${encodeURIComponent(name)}/versions/latest:access`;
    const r = await this.f(url, { headers: { authorization: `Bearer ${await this.token()}` } });
    let v: string | undefined;
    if (r.status !== 404) {
      if (!r.ok) throw new Error(`secret ${name}: HTTP ${r.status} (is the caller's service account a secretAccessor on it?)`);
      v = Buffer.from(((await r.json()) as { payload: { data: string } }).payload.data, "base64").toString("utf8");
    }
    this.cache.set(name, { v, exp: Date.now() + CACHE_MS });
    return v;
  }
}

/** `SECRET_<NAME>` environment variables, with `-` as `_` (local and k8s dev). */
export class EnvSecretStore implements SecretStore {
  async get(name: string): Promise<string | undefined> {
    return process.env[`SECRET_${name.toUpperCase().replace(/-/g, "_")}`] || undefined;
  }
}
