import type { ClaudeAccount } from "./accounts.js";
import type { ClaudeSettings } from "./settings.js";

export interface WindowUsage {
  status?: string | undefined;
  /** 0..1 */
  utilization?: number | undefined;
  reset?: Date | undefined;
}

export interface AccountUsage {
  name: string;
  fingerprint: string;
  unifiedStatus?: string | undefined;
  representativeClaim?: string | undefined;
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
  overage: WindowUsage & { disabledReason?: string | undefined };
  checkedAt?: Date | undefined;
  lastError?: string | undefined;
}

type Headers = { get(name: string): string | null };
type Parsed = Pick<AccountUsage, "unifiedStatus" | "representativeClaim" | "fiveHour" | "sevenDay" | "overage">;

const P = "anthropic-ratelimit-unified-";

/** Parses the unified rate-limit headers of a /v1/messages response. Any header may be missing or malformed; that field is just undefined. */
export function parseUsageHeaders(h: Headers): Parsed {
  const str = (k: string): string | undefined => h.get(P + k)?.trim() || undefined;
  const num = (k: string): number | undefined => {
    const v = str(k);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const date = (k: string): Date | undefined => {
    const n = num(k);
    return n === undefined ? undefined : new Date(n * 1000);
  };
  const win = (w: string): WindowUsage => ({ status: str(`${w}-status`), utilization: num(`${w}-utilization`), reset: date(`${w}-reset`) });
  return {
    unifiedStatus: str("status"),
    representativeClaim: str("representative-claim"),
    fiveHour: win("5h"),
    sevenDay: win("7d"),
    overage: { ...win("overage"), disabledReason: str("overage-disabled-reason") },
  };
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Usage is only readable from the rate-limit headers of a real /v1/messages call (GET /api/oauth/usage rejects
 * setup-token tokens). One 1-token haiku request per account. Headers come back on 429 too, so they are parsed
 * whatever the status; an error is reported only when there is nothing to read.
 */
export async function probeAccount(account: ClaudeAccount, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<AccountUsage> {
  const base = { name: account.name, fingerprint: account.fingerprint, checkedAt: now() };
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${account.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const parsed = parseUsageHeaders(res.headers);
    const hasHeaders = parsed.unifiedStatus !== undefined || parsed.fiveHour.status !== undefined || parsed.fiveHour.utilization !== undefined || parsed.sevenDay.utilization !== undefined;
    if (!hasHeaders) return { ...base, ...parsed, lastError: `HTTP ${res.status}: no rate-limit headers` };
    return { ...base, ...parsed };
  } catch (e) {
    return { ...base, fiveHour: {}, sevenDay: {}, overage: {}, lastError: e instanceof Error ? e.message : String(e) };
  }
}

// ---- account choice

/** At or above this a window counts as exhausted even while its status still says allowed. */
export const FULL = 0.98;
const OK_STATUS = new Set(["allowed", "allowed_warning"]);

/** A window whose reset time has passed is clear, whatever the last probe saw (it may be minutes stale). */
const live = (w: WindowUsage, now: Date): WindowUsage => (w.reset && w.reset <= now ? {} : w);
const exhausted = (w: WindowUsage): boolean => (w.status !== undefined && !OK_STATUS.has(w.status)) || (w.utilization ?? 0) >= FULL;

export interface Availability {
  ok: boolean;
  /** When blocked: the earliest time this account is usable again, if the data says. */
  until?: Date | undefined;
}

export function availability(u: AccountUsage | undefined, allowOverage: boolean, now: Date): Availability {
  if (!u) return { ok: true }; // never probed: assume usable rather than refuse to run
  const windows = [live(u.fiveHour, now), live(u.sevenDay, now)];
  const blocked = windows.filter(exhausted);
  const overage = live(u.overage, now);
  const overageOpen = overage.status === "allowed" && (overage.utilization ?? 0) < FULL && (u.unifiedStatus === undefined || OK_STATUS.has(u.unifiedStatus));
  const latest = (ws: WindowUsage[]): Date | undefined => ws.map((w) => w.reset).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  if (blocked.length > 0) {
    if (allowOverage && overageOpen) return { ok: true };
    return { ok: false, until: latest(blocked) };
  }
  const inOverage = u.representativeClaim === "overage" || (overage.utilization ?? 0) > 0;
  if (inOverage && !allowOverage) return { ok: false, until: latest(windows) };
  if (inOverage && exhausted(overage)) return { ok: false, until: overage.reset };
  return { ok: true };
}

export interface Choice {
  /** The chosen account; absent when none qualifies. */
  account?: string | undefined;
  /** None qualifies: the earliest time one is usable again, and which. */
  waitUntil?: Date | undefined;
  waitAccount?: string | undefined;
}

/**
 * Pick the account for a task. Qualifying = usable per `availability` (all of them when `ignoreLimits`). Among those,
 * `preferred` order first, then most 5h headroom, then name. Nothing qualifies = when to look again (earliest unblock).
 */
export function chooseAccount(args: {
  accounts: { name: string }[];
  usage: Map<string, AccountUsage>;
  settings: Pick<ClaudeSettings, "allowOverage" | "preferred">;
  now: Date;
  exclude?: string[] | undefined;
  ignoreLimits?: boolean | undefined;
}): Choice {
  const { usage, settings, now } = args;
  const rows = args.accounts.filter((a) => !args.exclude?.includes(a.name)).map((a) => ({ name: a.name, u: usage.get(a.name), av: availability(usage.get(a.name), settings.allowOverage, now) }));
  const ok = rows.filter((r) => args.ignoreLimits || r.av.ok);
  if (ok.length === 0) {
    const soonest = rows.filter((r) => r.av.until).sort((a, b) => a.av.until!.getTime() - b.av.until!.getTime())[0];
    return { waitUntil: soonest?.av.until, waitAccount: soonest?.name };
  }
  const rank = (n: string): number => {
    const i = settings.preferred.indexOf(n);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const headroom = (u: AccountUsage | undefined): number => 1 - (u ? (live(u.fiveHour, now).utilization ?? 0) : 0);
  ok.sort((a, b) => rank(a.name) - rank(b.name) || headroom(b.u) - headroom(a.u) || a.name.localeCompare(b.name));
  return { account: ok[0]!.name };
}
