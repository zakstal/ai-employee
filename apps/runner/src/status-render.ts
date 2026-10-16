/** Compact text for GET /agents/self/status: what the owner reads in chat. Pure, so it is unit-tested without the MCP transport. */

interface Window {
  utilization: number | null;
  resetsAt: string | null;
}
export interface StatusBody {
  employee: string;
  now: string;
  currentTask: string;
  active: {
    id: string;
    role: string;
    status: string;
    channel: string;
    parent: string | null;
    root: string;
    startedAt: string;
    updatedAt: string;
    ageSec: number;
    account: string | null;
    costUsd: number | null;
    progress: string | null;
    question?: string;
  }[];
  finished: { id: string; role: string; status: string; channel: string; finishedAt: string; costUsd: number | null; result: string }[];
  claude: {
    currentAccount: string | null;
    settings: { limitPolicy: string; allowOverage: boolean; warnAt: number; preferred: string[] };
    accounts: { name: string; available: boolean; availableAgainAt?: string; fiveHour: Window; sevenDay: Window; overage: { status: string | null; inUse?: boolean | null }; checkedAt: string | null; lastError: string | null }[];
  };
}

export const duration = (sec: number): string => {
  if (sec < 90) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d${h % 24}h`;
};
const usd = (c: number | null): string => (c === null ? "-" : `$${c.toFixed(2)}`);
const pct = (u: number | null): string => (u === null ? "?" : `${Math.round(u * 100)}%`);
/** A table row: a pipe inside a field must not add a column. */
const row = (...fields: string[]): string => fields.map((f) => f.replace(/\|/g, "/")).join(" | ");

export function renderStatus(b: StatusBody): string {
  const out: string[] = [`${b.employee} @ ${b.now} (this task: ${b.currentTask})`, ""];
  out.push(`RUNNING NOW (${b.active.length})`);
  if (b.active.length === 0) out.push("nothing in flight");
  else {
    out.push("id | role | status | source | parent/root | age | account | cost | latest");
    for (const t of b.active) {
      const lineage = t.parent ? `${t.parent} / ${t.root}` : "root";
      const latest = t.question ? `ASKS: ${t.question}` : (t.progress ?? "(no output yet)");
      out.push(row(t.id, t.role, t.status, t.channel, lineage, duration(t.ageSec), t.account ?? "-", usd(t.costUsd), latest));
    }
  }
  out.push("", `FINISHED LAST 24H (${b.finished.length})`);
  if (b.finished.length === 0) out.push("none");
  else {
    out.push("id | role | status | source | finished | cost | result");
    for (const t of b.finished) out.push(row(t.id, t.role, t.status, t.channel, t.finishedAt, usd(t.costUsd), t.result || "-"));
  }
  const c = b.claude;
  out.push("", `CLAUDE ACCOUNTS (policy ${c.settings.limitPolicy}; overage ${c.settings.allowOverage ? "allowed" : "not allowed"}; warn at ${pct(c.settings.warnAt)}; preferred ${c.settings.preferred.join(", ") || "none"})`);
  if (c.accounts.length === 0) out.push("none configured");
  for (const a of c.accounts) {
    const state = a.available ? "available" : `AT LIMIT${a.availableAgainAt ? ` until ${a.availableAgainAt}` : ""}`;
    out.push(
      `${a.name}${a.name === c.currentAccount ? " (this task)" : ""} | ${state} | 5h ${pct(a.fiveHour.utilization)} resets ${a.fiveHour.resetsAt ?? "?"} | 7d ${pct(a.sevenDay.utilization)} resets ${a.sevenDay.resetsAt ?? "?"}` +
        `${a.overage.inUse ? " | BILLING OVERAGE" : ""}${a.lastError ? ` | probe error: ${a.lastError}` : ""}`,
    );
  }
  return out.join("\n");
}
