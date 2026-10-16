import { createHash } from "node:crypto";

export interface ClaudeAccount {
  /** Lowercased suffix of CLAUDE_CODE_OAUTH_TOKEN_<NAME>; the legacy unsuffixed variable is "default". */
  name: string;
  token: string;
  /** First 12 hex chars of sha256(token). Safe to show; the token itself is never logged or returned. */
  fingerprint: string;
}

export const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 12);

/** Every `CLAUDE_CODE_OAUTH_TOKEN_<NAME>` is an account `<name>`; the bare `CLAUDE_CODE_OAUTH_TOKEN` alone is `default`. */
export function claudeAccountsFromEnv(env: NodeJS.ProcessEnv): ClaudeAccount[] {
  const out: ClaudeAccount[] = [];
  for (const [k, v] of Object.entries(env)) {
    const m = /^CLAUDE_CODE_OAUTH_TOKEN_(.+)$/.exec(k);
    const token = v?.trim();
    if (m && token) out.push({ name: m[1]!.toLowerCase(), token, fingerprint: fingerprint(token) });
  }
  const legacy = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (out.length === 0 && legacy) out.push({ name: "default", token: legacy, fingerprint: fingerprint(legacy) });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
