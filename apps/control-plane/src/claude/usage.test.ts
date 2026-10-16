import { describe, expect, it } from "vitest";
import { claudeAccountsFromEnv } from "./accounts.js";
import { availability, chooseAccount, parseUsageHeaders, probeAccount, type AccountUsage } from "./usage.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const FUTURE = new Date("2026-10-16T15:00:00Z");
const FUTURE2 = new Date("2026-10-16T17:00:00Z");
const hdrs = (o: Record<string, string>) => new Headers(Object.fromEntries(Object.entries(o).map(([k, v]) => [`anthropic-ratelimit-unified-${k}`, v])));

const FULL_HEADERS = {
  status: "allowed",
  "5h-status": "allowed",
  "5h-utilization": "0.85",
  "5h-reset": "1792176600",
  "7d-status": "allowed_warning",
  "7d-utilization": "0.4",
  "7d-reset": "1792500000",
  "overage-status": "rejected",
  "overage-utilization": "0",
  "overage-reset": "1793000000",
  "overage-disabled-reason": "org_level_disabled",
  "representative-claim": "five_hour",
  "fallback-percentage": "0.5",
  fallback: "available",
};

describe("parseUsageHeaders", () => {
  it("parses every field", () => {
    const u = parseUsageHeaders(hdrs(FULL_HEADERS));
    expect(u.unifiedStatus).toBe("allowed");
    expect(u.representativeClaim).toBe("five_hour");
    expect(u.fiveHour).toEqual({ status: "allowed", utilization: 0.85, reset: new Date(1792176600 * 1000) });
    expect(u.sevenDay).toEqual({ status: "allowed_warning", utilization: 0.4, reset: new Date(1792500000 * 1000) });
    expect(u.overage).toEqual({ status: "rejected", utilization: 0, reset: new Date(1793000000 * 1000), disabledReason: "org_level_disabled" });
  });

  it("leaves missing fields undefined", () => {
    const u = parseUsageHeaders(hdrs({ "5h-utilization": "0.1" }));
    expect(u.fiveHour).toEqual({ status: undefined, utilization: 0.1, reset: undefined });
    expect(u.sevenDay).toEqual({ status: undefined, utilization: undefined, reset: undefined });
    expect(u.overage.disabledReason).toBeUndefined();
    expect(u.unifiedStatus).toBeUndefined();
  });

  it("ignores malformed numbers", () => {
    const u = parseUsageHeaders(hdrs({ "5h-utilization": "lots", "5h-reset": "soon", "7d-utilization": "" }));
    expect(u.fiveHour.utilization).toBeUndefined();
    expect(u.fiveHour.reset).toBeUndefined();
    expect(u.sevenDay.utilization).toBeUndefined();
  });
});

describe("probeAccount", () => {
  const [acct] = claudeAccountsFromEnv({ CLAUDE_CODE_OAUTH_TOKEN_A: "sk-ant-oat01-tok" });

  it("sends the 1-token haiku request with the oauth headers and parses the response headers", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200, headers: hdrs(FULL_HEADERS) });
    }) as unknown as typeof fetch;
    const u = await probeAccount(acct!, fake, () => NOW);
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk-ant-oat01-tok");
    expect(h["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(u).toMatchObject({ name: "a", fingerprint: acct!.fingerprint, checkedAt: NOW });
    expect(u.lastError).toBeUndefined();
    expect(u.fiveHour.utilization).toBe(0.85);
  });

  it("still reads headers from a 429", async () => {
    const fake = (async () => new Response("{}", { status: 429, headers: hdrs({ ...FULL_HEADERS, status: "rejected", "5h-status": "rejected", "5h-utilization": "1" }) })) as unknown as typeof fetch;
    const u = await probeAccount(acct!, fake, () => NOW);
    expect(u.lastError).toBeUndefined();
    expect(u.fiveHour.status).toBe("rejected");
  });

  it("reports an error when there are no rate-limit headers or the call throws, without the token", async () => {
    const none = await probeAccount(acct!, (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch, () => NOW);
    expect(none.lastError).toBe("HTTP 403: no rate-limit headers");
    const boom = await probeAccount(acct!, (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch, () => NOW);
    expect(boom.lastError).toBe("ECONNRESET");
    expect(JSON.stringify([none, boom])).not.toContain("sk-ant");
  });
});

function usage(name: string, o: { u5?: number; s5?: string; r5?: Date; u7?: number; s7?: string; r7?: Date; ov?: string; ovu?: number; claim?: string; unified?: string }): AccountUsage {
  return {
    name,
    fingerprint: "f",
    unifiedStatus: o.unified ?? "allowed",
    representativeClaim: o.claim ?? "five_hour",
    fiveHour: { status: o.s5 ?? "allowed", utilization: o.u5 ?? 0, reset: o.r5 ?? FUTURE },
    sevenDay: { status: o.s7 ?? "allowed", utilization: o.u7 ?? 0, reset: o.r7 ?? FUTURE2 },
    overage: { status: o.ov ?? "rejected", utilization: o.ovu ?? 0 },
  };
}
const map = (...us: AccountUsage[]) => new Map(us.map((u) => [u.name, u]));
const names = (...n: string[]) => n.map((name) => ({ name }));
const S = { allowOverage: false, preferred: [] as string[] };

describe("availability", () => {
  it("allows an account that was never probed", () => {
    expect(availability(undefined, false, NOW).ok).toBe(true);
  });
  it("blocks on a non-allowed window status and reports when it clears", () => {
    expect(availability(usage("a", { s5: "rejected", u5: 1 }), false, NOW)).toEqual({ ok: false, until: FUTURE });
    // both windows out: usable again only when both clear
    expect(availability(usage("a", { s5: "rejected", s7: "rejected" }), false, NOW).until).toEqual(FUTURE2);
  });
  it("treats allowed_warning as allowed", () => {
    expect(availability(usage("a", { s5: "allowed_warning", u5: 0.9 }), false, NOW).ok).toBe(true);
  });
  it("blocks at 0.98 utilization even while status says allowed; 0.97 passes", () => {
    expect(availability(usage("a", { u5: 0.98 }), false, NOW).ok).toBe(false);
    expect(availability(usage("a", { u7: 0.99 }), false, NOW).ok).toBe(false);
    expect(availability(usage("a", { u5: 0.97 }), false, NOW).ok).toBe(true);
  });
  it("treats a window whose reset already passed as clear (probe data is stale)", () => {
    expect(availability(usage("a", { s5: "rejected", u5: 1, r5: new Date("2026-10-16T11:00:00Z") }), false, NOW).ok).toBe(true);
  });
  it("overage: blocked unless allowOverage; with it, an exhausted window spills into open overage", () => {
    const spilled = usage("a", { s5: "rejected", u5: 1, ov: "allowed", ovu: 0.2, claim: "overage" });
    expect(availability(spilled, false, NOW).ok).toBe(false);
    expect(availability(spilled, true, NOW).ok).toBe(true);
    // overage itself used up
    expect(availability(usage("a", { s5: "rejected", u5: 1, ov: "allowed", ovu: 0.99 }), true, NOW).ok).toBe(false);
    // overage disabled: allowOverage does not help
    expect(availability(usage("a", { s5: "rejected", u5: 1, ov: "rejected" }), true, NOW).ok).toBe(false);
  });
  it("an account already billing overage is skipped unless allowOverage, even with windows allowed", () => {
    const u = usage("a", { ov: "allowed", ovu: 0.1, claim: "overage" });
    expect(availability(u, false, NOW).ok).toBe(false);
    expect(availability(u, true, NOW).ok).toBe(true);
  });
});

describe("chooseAccount", () => {
  const pick = (us: AccountUsage[], o: Partial<Parameters<typeof chooseAccount>[0]> & { settings?: typeof S } = {}) =>
    chooseAccount({ accounts: names(...us.map((u) => u.name)), usage: map(...us), settings: S, now: NOW, ...o });

  it("prefers the most 5h headroom", () => {
    expect(pick([usage("a", { u5: 0.7 }), usage("b", { u5: 0.2 }), usage("c", { u5: 0.5 })]).account).toBe("b");
  });
  it("preferred order beats headroom; non-preferred follow by headroom", () => {
    const us = [usage("a", { u5: 0.1 }), usage("b", { u5: 0.9 }), usage("c", { u5: 0.5 })];
    expect(pick(us, { settings: { ...S, preferred: ["b", "c"] } }).account).toBe("b");
    expect(pick(us, { settings: { ...S, preferred: ["c"] } }).account).toBe("c");
  });
  it("skips a preferred account that does not qualify", () => {
    const us = [usage("a", { u5: 0.1 }), usage("b", { s5: "rejected", u5: 1 })];
    expect(pick(us, { settings: { ...S, preferred: ["b"] } }).account).toBe("a");
  });
  it("skips exhausted accounts and honours exclude", () => {
    const us = [usage("a", { u5: 0.99 }), usage("b", { u5: 0.5 }), usage("c", { u5: 0.6 })];
    expect(pick(us).account).toBe("b");
    expect(pick(us, { exclude: ["b"] }).account).toBe("c");
  });
  it("overage accounts only when allowOverage", () => {
    const us = [usage("a", { s5: "rejected", u5: 1, ov: "allowed", ovu: 0.1, claim: "overage" })];
    expect(pick(us).account).toBeUndefined();
    expect(pick(us, { settings: { ...S, allowOverage: true } }).account).toBe("a");
  });
  it("none qualifies: says when the earliest account frees up, and which", () => {
    const us = [usage("a", { s5: "rejected", u5: 1, r5: FUTURE2 }), usage("b", { s5: "rejected", u5: 1, r5: FUTURE })];
    expect(pick(us)).toEqual({ account: undefined, waitUntil: FUTURE, waitAccount: "b" });
  });
  it("none qualifies and no reset known: no waitUntil", () => {
    const u = usage("a", { s5: "rejected", u5: 1 });
    u.fiveHour.reset = undefined;
    u.sevenDay.reset = undefined;
    expect(pick([u]).waitUntil).toBeUndefined();
  });
  it("ignoreLimits (policy off) still picks, by order", () => {
    const us = [usage("a", { s5: "rejected", u5: 1 }), usage("b", { s5: "rejected", u5: 1 })];
    expect(pick(us, { ignoreLimits: true, settings: { ...S, preferred: ["b"] } }).account).toBe("b");
  });
  it("unprobed accounts count as full headroom", () => {
    expect(chooseAccount({ accounts: names("a", "b"), usage: map(usage("a", { u5: 0.3 })), settings: S, now: NOW }).account).toBe("b");
  });
});
