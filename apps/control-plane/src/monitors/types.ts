/** One thing worth a human's or a model's attention. `key` is stable per signature so diffs dedup on it. */
export interface Finding {
  key: string;
  text: string;
  /**
   * Where this came from, verbatim enough that a human can re-run it: the resource, the exact query, the
   * window, the counts, a portal link. Carried into the ClickUp task and the PR so a fix always states the
   * evidence it was based on.
   */
  evidence?: Evidence;
}

export interface Evidence {
  /** e.g. "Application Insights (my-rg/my-app-insights)" or "ClickUp #support" */
  source: string;
  /** Exact query or API call that produced it, runnable as-is. */
  query?: string;
  /** Time window the numbers cover, e.g. "last 15m as of 2026-09-18T15:27:00Z". */
  window?: string;
  /** Counts and comparisons, e.g. "56 occurrences (24h peak 0)". */
  observed?: string;
  /** Deep link a human can open. */
  url?: string;
}

/** Markdown block for a prompt / ticket / PR body. */
export function renderEvidence(e: Evidence): string {
  const lines = [`  source: ${e.source}`];
  if (e.window) lines.push(`  window: ${e.window}`);
  if (e.observed) lines.push(`  observed: ${e.observed}`);
  if (e.url) lines.push(`  link: ${e.url}`);
  if (e.query) lines.push(`  query:\n${e.query.split("\n").map((l) => `    ${l}`).join("\n")}`);
  return lines.join("\n");
}

export interface CollectResult {
  findings: Finding[];
  /** Next state; persisted by the tick and handed back on the next run. */
  state: Record<string, unknown>;
}

export type Fetch = typeof fetch;
