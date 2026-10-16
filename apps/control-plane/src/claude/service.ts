import { parseLimitMessage, type LimitHit } from "@ai-employee/core";
import type { Config } from "../config.js";
import type { Ledger } from "../db/ledger.js";
import type { ClickUpClient } from "../clickup/client.js";
import type { ClaudeAccount } from "./accounts.js";
import { ClaudeSettingsPatchSchema, ClaudeSettingsSchema, DEFAULT_CLAUDE_SETTINGS, type ClaudeSettings } from "./settings.js";
import { availability, chooseAccount, probeAccount, type AccountUsage, type WindowUsage } from "./usage.js";

/** No usable reset time anywhere: look again after this long. */
export const FALLBACK_WAIT_MS = 30 * 60_000;
const SETTINGS_KEY = "claude";

export type Pick =
  | { kind: "unconfigured" }
  | { kind: "account"; account: ClaudeAccount }
  | { kind: "blocked"; waitUntil?: Date | undefined; message: string };

/** What the control plane tells a runner whose account hit its limit. `token` is only ever sent to that run's own authenticated request. */
export type LimitDecision =
  | { action: "failover"; account: string; token: string }
  | { action: "wait"; waitUntil: string; account?: string; token?: string }
  | { action: "exit"; reason: string };

export interface ClaudeServiceDeps {
  config: Config;
  ledger: Ledger;
  clickup?: ClickUpClient | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}

const win = (w: WindowUsage) => ({ status: w.status ?? null, utilization: w.utilization ?? null, resetsAt: w.reset?.toISOString() ?? null });

export class ClaudeService {
  constructor(private d: ClaudeServiceDeps) {}

  private now = (): Date => (this.d.now ?? (() => new Date()))();
  get accounts(): ClaudeAccount[] {
    return this.d.config.claudeAccounts;
  }

  async settings(): Promise<ClaudeSettings> {
    const stored = await this.d.ledger.getSetting<unknown>(SETTINGS_KEY);
    const parsed = ClaudeSettingsSchema.safeParse(stored ?? {});
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_SETTINGS; // a hand-edited bad row must not stop launches
  }

  /** Merges a validated patch over the current settings. Throws a ZodError on bad input. */
  async updateSettings(patch: unknown): Promise<ClaudeSettings> {
    const p = ClaudeSettingsPatchSchema.parse(patch);
    const next = ClaudeSettingsSchema.parse({ ...(await this.settings()), ...p });
    await this.d.ledger.setSetting(SETTINGS_KEY, next);
    return next;
  }

  private async usageMap(): Promise<Map<string, AccountUsage>> {
    return new Map((await this.d.ledger.listAccountUsage()).map((u) => [u.name, u]));
  }

  /** Per-account snapshot (no tokens) plus current settings. */
  async snapshot() {
    const [usage, settings] = await Promise.all([this.usageMap(), this.settings()]);
    const now = this.now();
    return {
      settings,
      checkIntervalMin: this.d.config.CLAUDE_USAGE_CHECK_MIN,
      accounts: this.accounts.map((a) => {
        const u = usage.get(a.name);
        const av = availability(u, settings.allowOverage, now);
        return {
          name: a.name,
          fingerprint: a.fingerprint,
          available: av.ok,
          ...(av.until ? { availableAgainAt: av.until.toISOString() } : {}),
          status: u?.unifiedStatus ?? null,
          representativeClaim: u?.representativeClaim ?? null,
          fiveHour: win(u?.fiveHour ?? {}),
          sevenDay: win(u?.sevenDay ?? {}),
          overage: { ...win(u?.overage ?? {}), disabledReason: u?.overage.disabledReason ?? null },
          checkedAt: u?.checkedAt?.toISOString() ?? null,
          lastError: u?.lastError ?? null,
        };
      }),
    };
  }

  /** Probe every account now, store the result, and alert on accounts over the warn threshold. */
  async refresh(): Promise<void> {
    const probed = await Promise.all(this.accounts.map((a) => probeAccount(a, this.d.fetch, this.now)));
    for (const u of probed) await this.d.ledger.saveAccountUsage(u);
    await this.alertOverThreshold(probed);
  }

  private async alertOverThreshold(probed: AccountUsage[]): Promise<void> {
    const { config, clickup, ledger } = this.d;
    if (!config.ALERT_CHANNEL_ID || !clickup) return;
    const { warnAt } = await this.settings();
    const sent = await ledger.alertedWindows();
    for (const u of probed) {
      for (const [label, w, prior] of [["5h", u.fiveHour, sent.get(u.name)?.fiveHour], ["7d", u.sevenDay, sent.get(u.name)?.sevenDay]] as const) {
        if (w.utilization === undefined || w.utilization < warnAt || !w.reset) continue;
        if (prior && Math.abs(prior.getTime() - w.reset.getTime()) < 60_000) continue; // already alerted for this window
        try {
          await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, config.ALERT_CHANNEL_ID, `🤖 ⚠️ Claude account "${u.name}" is at ${Math.round(w.utilization * 100)}% of its ${label} limit (resets ${w.reset.toISOString()})`);
          await ledger.markWindowAlerted(u.name, label, w.reset);
        } catch (e) {
          console.error("failed to post Claude usage alert", e); // retried at the next probe
        }
      }
    }
  }

  /** Account for a new task, per settings. `off` never refuses: it still orders by preference and headroom. */
  async pickForLaunch(): Promise<Pick> {
    if (this.accounts.length === 0) return { kind: "unconfigured" };
    const settings = await this.settings();
    const c = chooseAccount({ accounts: this.accounts, usage: await this.usageMap(), settings, now: this.now(), ignoreLimits: settings.limitPolicy === "off" });
    if (c.account) return { kind: "account", account: this.accounts.find((a) => a.name === c.account)! };
    if (settings.limitPolicy === "wait" || settings.limitPolicy === "failover-then-wait") {
      const waitUntil = c.waitUntil ?? new Date(this.now().getTime() + FALLBACK_WAIT_MS);
      return { kind: "blocked", waitUntil, message: `every Claude account is at its limit; waiting until ${waitUntil.toISOString()}` };
    }
    return { kind: "blocked", message: `every Claude account is at its limit and limitPolicy is "${settings.limitPolicy}"` };
  }

  /** Record that `account` hit its limit (from a runner report or a task's final message). */
  async recordLimit(account: string, hit: LimitHit): Promise<void> {
    const a = this.accounts.find((x) => x.name === account);
    if (a) await this.d.ledger.markAccountLimited(a.name, a.fingerprint, hit.window, hit.resetsAt, this.now());
  }

  /** A task that ended with the limit message as its result: remember the account is out. */
  async recordLimitFromResult(taskId: string, text: string | undefined): Promise<void> {
    const hit = text ? parseLimitMessage(text, this.now()) : undefined;
    const account = hit ? (await this.d.ledger.getTask(taskId))?.claude_account : undefined;
    if (hit && account) await this.recordLimit(account, hit);
  }

  /** A running task's account hit its limit: apply limitPolicy. */
  async onLimit(taskId: string, report: { account?: string | undefined; resetsAt?: Date | undefined; window?: "5h" | "7d" | undefined }): Promise<LimitDecision> {
    const task = await this.d.ledger.getTask(taskId);
    const current = task?.claude_account ?? report.account;
    if (current) await this.recordLimit(current, { window: report.window ?? "5h", resetsAt: report.resetsAt });
    const settings = await this.settings();
    if (settings.limitPolicy === "off") return { action: "exit", reason: 'limitPolicy is "off"' };

    const usage = await this.usageMap();
    const now = this.now();
    const ownReset = report.resetsAt ?? usage.get(current ?? "")?.[report.window === "7d" ? "sevenDay" : "fiveHour"].reset;
    const own = ownReset && ownReset > now ? ownReset : undefined; // a reset already in the past is no information
    const switchTo = async (name: string) => {
      await this.d.ledger.setTaskClaudeAccount(taskId, name);
      return this.accounts.find((a) => a.name === name)!;
    };

    if (settings.limitPolicy === "failover" || settings.limitPolicy === "failover-then-wait") {
      const c = chooseAccount({ accounts: this.accounts, usage, settings, now, exclude: current ? [current] : [] });
      if (c.account) {
        const a = await switchTo(c.account);
        return { action: "failover", account: a.name, token: a.token };
      }
      if (settings.limitPolicy === "failover") return { action: "exit", reason: "no other Claude account has headroom" };
      // Nothing else has headroom: wait for whichever account frees up first, this one included, and continue on it.
      if (c.waitUntil && c.waitAccount && (!own || c.waitUntil < own)) {
        const a = await switchTo(c.waitAccount);
        return { action: "wait", waitUntil: c.waitUntil.toISOString(), account: a.name, token: a.token };
      }
    }
    // "wait": same account, once its window resets.
    return { action: "wait", waitUntil: (own ?? new Date(now.getTime() + FALLBACK_WAIT_MS)).toISOString() };
  }
}
