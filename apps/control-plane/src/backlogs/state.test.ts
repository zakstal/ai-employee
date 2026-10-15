import { describe, expect, it } from "vitest";
import { BacklogSchema } from "@ai-employee/core";
import { NoopClickUpClient } from "../clickup/client.js";
import { renderBacklogState, renderBacklogs } from "./render.js";
import { readBacklogState, type BacklogTaskRow } from "./state.js";

const FILE = `## Phase 1
- [ ] Button
- [ ] Badge
- [x] Icon
## Phase 2
- [ ] Input <!-- depends: Button -->
- [ ] Select
`;
type Pr = { head: { ref: string }; state: string; merged_at: string | null };

function mkFetch(prs: Pr[], file = FILE, branches: string[] = []) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (url.includes("/contents/")) return new Response(file);
    if (url.includes("/pulls?")) return new Response(JSON.stringify(url.includes("page=1") ? prs : []));
    if (url.includes("/branches")) return new Response(JSON.stringify(branches.map((name) => ({ name }))));
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const mk = (over: Record<string, unknown> = {}) =>
  BacklogSchema.parse({ source: { kind: "repo-file", repo: "o/r", ref: "feat", path: "L.md" }, dispatch: { role: "implement", brief: "b" }, concurrency: 2, done: { base: "feat" }, ...over });
const task = (id: string, item: string, status: string, text: string | null = null, n = 0): BacklogTaskRow => ({ id, status, item, text, createdAt: new Date(1000 + n) });
const run = (b: ReturnType<typeof mk>, prs: Pr[], tasks: BacklogTaskRow[] = [], branches: string[] = []) =>
  readBacklogState({ fetch: mkFetch(prs, FILE, branches).f, clickup: new NoopClickUpClient(), githubToken: "t", tasks: async () => tasks }, "bl", b);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("readBacklogState", () => {
  it("ready excludes running and done; free slots = concurrency - running", async () => {
    const s = await run(mk(), [], [task("a", "button", "running")]);
    expect(ids(s.done)).toEqual(["icon"]);
    expect(ids(s.runningItems)).toEqual(["button"]);
    expect(ids(s.ready)).toEqual(["badge", "select"]);
    expect(ids(s.blocked)).toEqual(["input"]);
    expect(s.blocked[0]!.waitingFor).toEqual(["button"]);
    expect([s.running, s.freeSlots]).toEqual([1, 1]);
  });
  it("pr-open counts an open or merged PR as done; pr-merged only merged", async () => {
    const prs: Pr[] = [{ head: { ref: "ai/bl/button" }, state: "open", merged_at: null }, { head: { ref: "ai/bl/badge" }, state: "closed", merged_at: "2026-01-01" }];
    expect(ids((await run(mk(), prs)).done).sort()).toEqual(["badge", "button", "icon"]);
    expect(ids((await run(mk({ done: { rule: "pr-merged", base: "feat" } }), prs)).done).sort()).toEqual(["badge", "icon"]);
  });
  it("a PR closed without merging is not done", async () => {
    const s = await run(mk(), [{ head: { ref: "ai/bl/button" }, state: "closed", merged_at: null }]);
    expect(ids(s.done)).toEqual(["icon"]);
  });
  it("branch-pushed reads the branch list", async () => {
    const s = await run(mk({ done: { rule: "branch-pushed" } }), [], [], ["ai/bl/badge", "other"]);
    expect(ids(s.done).sort()).toEqual(["badge", "icon"]);
  });
  it("phase gate holds phase 2 until phase 1 is merged", async () => {
    const b = mk({ phaseGate: "merged", order: "phase" });
    const open: Pr[] = [{ head: { ref: "ai/bl/button" }, state: "open", merged_at: null }, { head: { ref: "ai/bl/badge" }, state: "open", merged_at: null }];
    expect(ids((await run(b, open)).blocked)).toEqual(["input", "select"]);
    const merged = open.map((p) => ({ ...p, state: "closed", merged_at: "x" }));
    expect(ids((await run(b, merged)).ready)).toEqual(["input", "select"]);
  });
  it("an item that failed twice is stopped, with the last failure kept", async () => {
    const s = await run(mk(), [], [task("a", "button", "failed", "boom 1", 1), task("b", "button", "failed", "boom 2", 2)]);
    expect(s.stopped).toHaveLength(1);
    expect(s.stopped[0]).toMatchObject({ id: "button", attempts: 2, lastFailure: "boom 2" });
    expect(ids(s.ready)).not.toContain("button");
  });
  it("one failed attempt is still ready, and says why it is a retry", async () => {
    const s = await run(mk(), [], [task("a", "button", "failed", "boom", 1)]);
    expect(s.ready[0]).toMatchObject({ id: "button", attempts: 1, lastFailure: "boom" });
  });
  it("order: phase sorts by phase, file keeps file order", async () => {
    const swapped = "## Phase 2\n- [ ] B2\n## Phase 1\n- [ ] A1\n";
    const get = (order: string) => readBacklogState({ fetch: mkFetch([], swapped).f, clickup: new NoopClickUpClient(), tasks: async () => [] }, "bl", mk({ order }));
    expect(ids((await get("file")).ready)).toEqual(["b2", "a1"]);
    expect(ids((await get("phase")).ready)).toEqual(["a1", "b2"]);
  });
  it("sends the token and reads the file at the ref", async () => {
    const { f, calls } = mkFetch([]);
    await readBacklogState({ fetch: f, clickup: new NoopClickUpClient(), githubToken: "t", tasks: async () => [] }, "bl", mk());
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/contents/L.md?ref=feat");
  });
  it("clickup-list: done by status, item id is the task id", async () => {
    const clickup = new NoopClickUpClient();
    clickup.listed.set("L", [{ id: "x1", name: "One", status: { status: "Complete" } }, { id: "x2", name: "Two", status: { status: "open" } }]);
    const b = BacklogSchema.parse({ source: { kind: "clickup-list", listId: "L" }, dispatch: { role: "r", brief: "b" } });
    const s = await readBacklogState({ fetch, clickup, tasks: async () => [] }, "bl", b);
    expect([ids(s.done), ids(s.ready)]).toEqual([["x1"], ["x2"]]);
  });
});

describe("render", () => {
  it("renders config and state, and degrades loudly when the source is unreadable", async () => {
    const b = mk({ description: "the rewrite" });
    const text = renderBacklogs({ backlogs: { bl: b } });
    expect(text).toContain("### bl");
    expect(text).toContain("halt after 3 consecutive failures");
    const state = renderBacklogState([{ id: "bl", state: await run(b, []) }, { id: "x", error: "github GET -> 401" }]);
    expect(state).toContain("ready (in order):");
    expect(state).toContain("State unavailable (github GET -> 401). Dispatch nothing");
    expect(renderBacklogs({})).toBe("");
  });
  it("a disabled backlog says so in both", async () => {
    const b = mk({ enabled: false });
    expect(renderBacklogs({ backlogs: { bl: b } })).toContain("DISABLED");
    expect(renderBacklogState([{ id: "bl", state: await run(b, []) }])).toContain("DISABLED: dispatch nothing");
  });
});
