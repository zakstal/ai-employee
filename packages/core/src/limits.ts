/**
 * Claude subscription usage-limit messages, shared by the runner (detects them mid-run) and the control plane
 * (records them when a task ends on one). Pure: no IO, clock injected.
 */

/** `claude -p` ends with e.g. "You've hit your session limit · resets 5:40pm (UTC)". */
export const LIMIT_RE = /hit your (session|usage|weekly)? ?limit/i;

export interface LimitHit {
  /** "weekly" = the 7-day window; "session" and a bare "usage" are treated as the 5-hour window. */
  window: "5h" | "7d";
  /** Next occurrence of the stated reset time. Undefined when the message gave none we could read. */
  resetsAt?: Date | undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** ms to ADD to UTC to get wall-clock time in `tz` at `at`. Throws RangeError on an unknown zone. */
function tzOffsetMs(tz: string, at: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at))
    .reduce((a: Record<string, string>, x) => ((a[x.type] = x.value), a), {});
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/** Wall-clock y-m-d h:min in `tz` -> UTC ms. Two passes so a DST edge lands on the right side. */
function zonedToUtc(y: number, mo: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, min);
  const first = guess - tzOffsetMs(tz, guess);
  return guess - tzOffsetMs(tz, first);
}

/** Next instant at or after `now` matching the clock text in `tz`; `month`/`day` pin a date, else the next day it occurs. */
function nextOccurrence(now: Date, tz: string, h: number, min: number, month?: number, day?: number): Date | undefined {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now.getTime())); // UTC fields of `local` are tz wall-clock
  const y = local.getUTCFullYear();
  const candidates =
    month !== undefined && day !== undefined
      ? [zonedToUtc(y, month, day, h, min, tz), zonedToUtc(y + 1, month, day, h, min, tz)]
      : [zonedToUtc(y, local.getUTCMonth(), local.getUTCDate(), h, min, tz), zonedToUtc(y, local.getUTCMonth(), local.getUTCDate() + 1, h, min, tz)];
  const hit = candidates.find((c) => c > now.getTime());
  return hit === undefined ? undefined : new Date(hit);
}

/** Reset time from the text after "resets": "5:40pm (UTC)", "5pm", "17:40 (Europe/Paris)", "Oct 17, 9am (UTC)", "in 3h 20m", or a trailing `|<epoch s>`. */
function parseReset(text: string, now: Date): Date | undefined {
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const rel = /resets?\s+in\s+(?:(\d+)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?/i.exec(text);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000);
  const m = /resets?\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  const [, mon, dayStr, hourStr, minStr, ampm, tzRaw] = m;
  let h = Number(hourStr);
  const min = Number(minStr ?? 0);
  if (ampm) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  } else if (!minStr || h > 23) return undefined; // a bare number with no am/pm and no minutes is not a time
  if (min > 59) return undefined;
  const tz = !tzRaw || /^utc|^gmt/i.test(tzRaw.trim()) ? "UTC" : tzRaw.trim();
  const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : undefined;
  if (month === -1) return undefined;
  try {
    return nextOccurrence(now, tz, h, min, month, dayStr ? Number(dayStr) : undefined);
  } catch {
    return undefined; // unknown time zone name
  }
}

/** undefined when `text` is not a usage-limit message. */
export function parseLimitMessage(text: string, now: Date = new Date()): LimitHit | undefined {
  const hit = LIMIT_RE.exec(text);
  if (!hit) return undefined;
  const tail = text.slice(hit.index + hit[0].length);
  return { window: hit[1]?.toLowerCase() === "weekly" ? "7d" : "5h", resetsAt: parseReset(tail, now) };
}
