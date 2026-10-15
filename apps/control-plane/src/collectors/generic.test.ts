import { describe, expect, it } from "vitest";
import { EmployeeSchema } from "@ai-employee/core";
import { NoopClickUpClient } from "../clickup/client.js";
import { clickupTaskStatus } from "./clickup-task-status.js";
import { gitBranches } from "./git-branches.js";
import { githubChecks } from "./github-checks.js";
import { githubPrs } from "./github-prs.js";
import type { CollectContext } from "./types.js";

const now = new Date("2026-10-15T12:00:00Z");
const json = (b: unknown) => new Response(JSON.stringify(b));

function ctx(routes: (url: string) => unknown, clickup = new NoopClickUpClient(), credential = "github"): CollectContext & { calls: string[]; headers: Record<string, string>[] } {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const employee = EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }] });
  return {
    employee, monitorName: "m", now, clickup, calls, headers, config: {} as never, secrets: {} as never,
    monitor: { collector: "x", everyMin: 5, role: "r", description: "", config: {}, credential },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(url);
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return json(routes(url));
    }) as unknown as typeof fetch,
    credential: async (name) => ({ GH_TOKEN: `tok-for-${name}` }),
  };
}
const run = async <C>(c: { collect(x: CollectContext, cfg: C, p: Record<string, unknown>): Promise<{ findings: { key: string; text: string }[]; state: Record<string, unknown> }> }, x: CollectContext, cfg: C, prev: Record<string, unknown> = {}) => c.collect(x, cfg, prev);

describe("github-prs", () => {
  const pr = (n: number, extra: object = {}) => ({ number: n, title: `T${n}`, html_url: `u${n}`, draft: false, user: { login: "zak" }, labels: [], requested_reviewers: [], ...extra });
  const cfg = githubPrs.configSchema.parse({ repos: ["o/r"] });
  it("first run is a silent baseline; a new PR is a finding once; unchanged state is silent", async () => {
    const page = (list: object[]) => (url: string) => (url.includes("page=1") ? list : []);
    const r1 = await run(githubPrs, ctx(page([pr(1)])), cfg);
    expect(r1.findings).toEqual([]);
    const c2 = ctx(page([pr(2), pr(1)]));
    const r2 = await run(githubPrs, c2, cfg, r1.state);
    expect(r2.findings.map((f) => f.key)).toEqual(["pr|o/r#2|opened"]);
    expect(c2.headers[0]!.authorization).toBe("Bearer tok-for-github");
    const r3 = await run(githubPrs, ctx(page([pr(2), pr(1)])), cfg, r2.state);
    expect(r3.findings).toEqual([]);
  });
  it("reports ready and review-requested, honours events, authors and labels", async () => {
    const page = (list: object[]) => (url: string) => (url.includes("page=1") ? list : []);
    const all = githubPrs.configSchema.parse({ repos: ["o/r"], events: ["opened", "ready", "review-requested"] });
    const r1 = await run(githubPrs, ctx(page([pr(1, { draft: true })])), all);
    const r2 = await run(githubPrs, ctx(page([pr(1, { draft: false, requested_reviewers: [{ login: "sia" }] })])), all, r1.state);
    expect(r2.findings.map((f) => f.key).sort()).toEqual(["pr|o/r#1|ready", "pr|o/r#1|review-requested|sia"]);
    const onlyReady = githubPrs.configSchema.parse({ repos: ["o/r"], events: ["ready"] });
    const q1 = await run(githubPrs, ctx(page([pr(1, { draft: true })])), onlyReady);
    const q2 = await run(githubPrs, ctx(page([pr(1, { requested_reviewers: [{ login: "sia" }] }), pr(2)])), onlyReady, q1.state);
    expect(q2.findings.map((f) => f.key)).toEqual(["pr|o/r#1|ready"]);
    const filtered = githubPrs.configSchema.parse({ repos: ["o/r"], authors: ["sia"], labels: ["ai"] });
    const f1 = await run(githubPrs, ctx(page([])), filtered);
    const f2 = await run(githubPrs, ctx(page([pr(5), pr(6, { user: { login: "sia" }, labels: [{ name: "ai" }] }), pr(7, { user: { login: "sia" } })])), filtered, f1.state);
    expect(f2.findings.map((f) => f.key)).toEqual(["pr|o/r#6|opened"]);
  });
  it("rejects a bad repo and uses the monitor's credential name", async () => {
    expect(githubPrs.configSchema.safeParse({ repos: ["nope"] }).success).toBe(false);
    const c = ctx(() => [], new NoopClickUpClient(), "gh-reader");
    await run(githubPrs, c, cfg);
    expect(c.headers[0]!.authorization).toBe("Bearer tok-for-gh-reader");
  });
});

describe("github-checks", () => {
  const checks = (sha: string, ...conclusions: (string | null)[]) => () => ({ check_runs: conclusions.map((conclusion, i) => ({ name: `job${i}`, conclusion, head_sha: sha })) });
  const cfg = githubChecks.configSchema.parse({ repos: ["o/r"] });
  it("silent baseline, then a finding when a commit goes failing, once per commit; pending is ignored", async () => {
    const r1 = await run(githubChecks, ctx(checks("a".repeat(40), "success")), cfg);
    expect(r1.findings).toEqual([]);
    const r2 = await run(githubChecks, ctx(checks("b".repeat(40), "success", "failure")), cfg, r1.state);
    expect(r2.findings.map((f) => f.key)).toEqual([`checks|o/r|main|${"b".repeat(40)}`]);
    expect(r2.findings[0]!.text).toContain("job1");
    const r3 = await run(githubChecks, ctx(checks("b".repeat(40), "success", "failure")), cfg, r2.state);
    expect(r3.findings).toEqual([]);
    const r4 = await run(githubChecks, ctx(checks("c".repeat(40), "success", null)), cfg, r3.state);
    expect(r4.findings).toEqual([]);
  });
});

describe("clickup-task-status", () => {
  const cu = (list: { id: string; name: string; s: string }[]) => {
    const c = new NoopClickUpClient();
    c.listed.set("L", list.map((t) => ({ id: t.id, name: t.name, status: { status: t.s } })));
    return c;
  };
  it("silent baseline; a task entering a wanted status is a finding once", async () => {
    const cfg = clickupTaskStatus.configSchema.parse({ listIds: ["L"], statuses: ["Ready for Dev"] });
    const r1 = await run(clickupTaskStatus, ctx(() => [], cu([{ id: "1", name: "A", s: "open" }])), cfg);
    expect(r1.findings).toEqual([]);
    const r2 = await run(clickupTaskStatus, ctx(() => [], cu([{ id: "1", name: "A", s: "ready for dev" }, { id: "2", name: "B", s: "open" }])), cfg, r1.state);
    expect(r2.findings.map((f) => f.key)).toEqual(["clickup-status|1|ready for dev"]);
    expect(r2.findings[0]!.text).toContain("moved open -> ready for dev");
    const r3 = await run(clickupTaskStatus, ctx(() => [], cu([{ id: "1", name: "A", s: "ready for dev" }, { id: "2", name: "B", s: "open" }])), cfg, r2.state);
    expect(r3.findings).toEqual([]);
  });
  it("without statuses any change counts", async () => {
    const cfg = clickupTaskStatus.configSchema.parse({ listIds: ["L"] });
    const r1 = await run(clickupTaskStatus, ctx(() => [], cu([{ id: "1", name: "A", s: "open" }])), cfg);
    const r2 = await run(clickupTaskStatus, ctx(() => [], cu([{ id: "1", name: "A", s: "done" }])), cfg, r1.state);
    expect(r2.findings).toHaveLength(1);
  });
});

describe("git-branches", () => {
  const br = (...b: [string, string][]) => (url: string) => (url.includes("page=1") ? b.map(([name, sha]) => ({ name, commit: { sha } })) : []);
  const cfg = gitBranches.configSchema.parse({ repos: ["o/r"], pattern: "ai/*" });
  it("a new matching branch or a moved head is a finding once; other branches are ignored", async () => {
    const r1 = await run(gitBranches, ctx(br(["main", "1"], ["ai/a", "1"])), cfg);
    expect(r1.findings).toEqual([]);
    const r2 = await run(gitBranches, ctx(br(["main", "2"], ["ai/a", "2"], ["ai/b/c", "9"])), cfg, r1.state);
    expect(r2.findings.map((f) => f.key)).toEqual(["branch|o/r@ai/a|2", "branch|o/r@ai/b/c|9"]);
    const r3 = await run(gitBranches, ctx(br(["main", "3"], ["ai/a", "2"], ["ai/b/c", "9"])), cfg, r2.state);
    expect(r3.findings).toEqual([]);
  });
});

describe("collect() through the monitor tick", () => {
  it("validates config (a bad one is a collector failure) and runs a plugin-style collector with the monitor's credential", async () => {
    const { collect, collectSafely } = await import("../monitors/tick.js");
    const { setWorkflowDeps } = await import("../orchestration/deps.js");
    const { vi } = await import("vitest");
    const employee = EmployeeSchema.parse({ id: "e", name: "E", defaultRole: "r", roles: [{ id: "r" }] });
    setWorkflowDeps({ config: { GH_TOKEN: "from-config", CLICKUP_TEAM_ID: "" }, clickup: new NoopClickUpClient(), secrets: {} } as never);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return json([]);
    });
    try {
      const mk = (config: object, state = {}) => ({ employee, name: "prs", monitor: { collector: "github-prs", everyMin: 5, role: "r", description: "", config }, row: { state } }) as never;
      const r = await collect(mk({ repos: ["o/r"] }), now);
      expect(r.state.initialized).toBe(true);
      expect(seen[0]).toBe("https://api.github.com/repos/o/r/pulls?state=open&sort=created&direction=desc&per_page=100&page=1 Bearer from-config");
      await expect(collect(mk({ repos: [] }), now)).rejects.toThrow();
      const first = await collectSafely(mk({ repos: [] }), now);
      expect(first.findings).toEqual([]); // one failure is silent
      const second = await collectSafely(mk({ repos: [] }, first.state), now);
      expect(second.findings[0]!.text).toMatch(/collector has failed 2 runs in a row/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
