import { CronExpressionParser } from "cron-parser";

const MIN_INTERVAL_MS = 15 * 60 * 1000;

export function nextFire(cron: string, tz: string, from: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toDate();
}

/** Enforces a floor of 15 minutes between consecutive fires (checked over the next two occurrences). */
export function validateCron(cron: string, tz: string): { ok: true; nextTwo: Date[] } | { ok: false; error: string } {
  let first: Date;
  let second: Date;
  try {
    const now = new Date();
    first = nextFire(cron, tz, now);
    second = nextFire(cron, tz, first);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
    return { ok: false, error: "cron must fire at least 15 minutes apart" };
  }
  return { ok: true, nextTwo: [first, second] };
}
