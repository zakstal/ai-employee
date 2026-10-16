import { describe, expect, it } from "vitest";
import { claudeAccountsFromEnv, fingerprint } from "./accounts.js";
import { loadConfig } from "../config.js";

describe("claudeAccountsFromEnv", () => {
  it("reads every CLAUDE_CODE_OAUTH_TOKEN_<NAME> as a lowercased account, sorted", () => {
    const accts = claudeAccountsFromEnv({ CLAUDE_CODE_OAUTH_TOKEN_WORK: "sk-ant-oat01-w", CLAUDE_CODE_OAUTH_TOKEN_Personal: "sk-ant-oat01-p" });
    expect(accts.map((a) => a.name)).toEqual(["personal", "work"]);
    expect(accts[1]!.token).toBe("sk-ant-oat01-w");
  });

  it("treats the legacy bare variable alone as account `default`", () => {
    expect(claudeAccountsFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" }).map((a) => a.name)).toEqual(["default"]);
  });

  it("ignores the legacy variable once named accounts exist, and empty values", () => {
    const accts = claudeAccountsFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: "old", CLAUDE_CODE_OAUTH_TOKEN_A: "a", CLAUDE_CODE_OAUTH_TOKEN_B: "  " });
    expect(accts.map((a) => a.name)).toEqual(["a"]);
  });

  it("fingerprints with 12 hex chars of sha256 and never puts the token in it", () => {
    const [a] = claudeAccountsFromEnv({ CLAUDE_CODE_OAUTH_TOKEN_A: "sk-ant-oat01-secret" });
    expect(a!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(a!.fingerprint).toBe(fingerprint("sk-ant-oat01-secret"));
    expect(a!.fingerprint).not.toContain("secret");
  });

  it("no tokens, no accounts; loadConfig carries them", () => {
    expect(claudeAccountsFromEnv({})).toEqual([]);
    const c = loadConfig({ DATABASE_URL: "x", DBOS_SYSTEM_DATABASE_URL: "x", CLAUDE_CODE_OAUTH_TOKEN_A: "t" } as NodeJS.ProcessEnv);
    expect(c.claudeAccounts.map((a) => a.name)).toEqual(["a"]);
    expect(c.CLAUDE_USAGE_CHECK_MIN).toBe(5);
  });
});
