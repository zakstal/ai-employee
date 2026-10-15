import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Config } from "../config.js";
import type { Stats } from "../db/ledger.js";
import { deps } from "./deps.js";

const PR_URL_RE = /https:\/\/github\.com\/\S+\/pull\/\d+/g;

/** Pure formatter, no IO — kept separate from postDigest so it's unit-testable without Postgres. */
export function buildDigest(stats: Stats, prs: string[]): string {
  const lines = [
    `**Daily digest — ${stats.until.slice(0, 10)}**`,
    `${stats.totals.tasks} tasks (${stats.totals.done} done, ${stats.totals.failed} failed) · est. cost $${stats.totals.costUsd.toFixed(4)} · ${stats.totals.inputTokens + stats.totals.outputTokens} tokens`,
  ];
  if (stats.byRole.length) {
    lines.push(stats.byRole.map((r) => `${r.role}: ${r.tasks} (${r.done} done, ${r.failed} failed, $${r.costUsd.toFixed(4)})`).join(" · "));
  }
  const top = stats.topTasks.slice(0, 3);
  if (top.length) {
    lines.push("Top tasks by cost:");
    for (const t of top) lines.push(`- $${t.costUsd.toFixed(4)} ${t.role}/${t.channel}: ${t.prompt.slice(0, 60)}`);
  }
  if (prs.length) {
    lines.push("PRs:");
    for (const url of prs) lines.push(`- ${url}`);
  }
  return lines.join("\n");
}

/** Computes the previous-24h stats and posts the digest. Skips silently when ALERT_CHANNEL_ID is unset. */
export async function postDigest(): Promise<void> {
  const { config, ledger, clickup } = deps();
  if (!config.ALERT_CHANNEL_ID) return;
  const until = new Date();
  const since = new Date(until.getTime() - 24 * 3_600_000);
  const stats = await ledger.stats(config.DEFAULT_EMPLOYEE_ID, since, until);
  const texts = await ledger.resultTextsSince(config.DEFAULT_EMPLOYEE_ID, since, until);
  const prs = [...new Set(texts.flatMap((t) => t.match(PR_URL_RE) ?? []))];
  await clickup.postChannelMessage(config.CLICKUP_TEAM_ID, config.ALERT_CHANNEL_ID, buildDigest(stats, prs));
}

async function digestWorkflowBody(): Promise<void> {
  await DBOS.runStep(() => postDigest(), { name: "postDigest" });
}

const digestWorkflow = DBOS.registerWorkflow(digestWorkflowBody, { name: "digestWorkflow" });

/**
 * DBOS crontabs have no timezone; they run in UTC. Convert the configured local hour to UTC
 * once, using the tz offset at boot time.
 * ponytail: if DIGEST_TZ observes DST, the digest drifts up to 1h from the configured local
 * time between a DST transition and the next process restart. Recompute daily (or use a
 * tz-aware scheduler) if that ever matters.
 */
export function crontabToUtc(crontab: string, tz: string, at: Date = new Date()): string {
  const fields = crontab.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected a 5-field crontab, got "${crontab}"`);
  const [minute, hour, dom, month, dow] = fields;
  const localHour = Number(hour);
  if (!Number.isInteger(localHour)) return crontab; // not a plain hour (e.g. "*/2") — leave as-is
  const utcHour = (((localHour - tzOffsetHours(tz, at)) % 24) + 24) % 24;
  return `${minute} ${Math.round(utcHour)} ${dom} ${month} ${dow}`;
}

/** Hours to ADD to UTC to get local wall-clock time in `tz`, at instant `at`. */
function tzOffsetHours(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .reduce((acc: Record<string, string>, p) => ((acc[p.type] = p.value), acc), {});
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asLocal - at.getTime()) / 3_600_000;
}

export function registerDigestWorkflow(config: Config): void {
  DBOS.registerScheduled(digestWorkflow, { crontab: crontabToUtc(config.DIGEST_CRON, config.DIGEST_TZ || config.DEFAULT_TZ) });
}
