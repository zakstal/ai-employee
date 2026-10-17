import { describe, expect, it, vi } from "vitest";
import type { ResultEvent, RunStatus, SandboxRuntime } from "@ai-employee/core";
import type { Ledger, TaskRow } from "../db/ledger.js";
import { sweepEndedSandboxes, type SweepDeps } from "./sweep.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const row = (id: string, o: Partial<TaskRow> = {}): TaskRow =>
  ({ id, employee_id: "dev", role_id: "supervisor", prompt: "p", source: { channel: "http" }, status: "running", run_handle: { adapter: "cloudrun", externalId: `exec-${id}` }, ...o }) as TaskRow;

function setup(tasks: TaskRow[], statuses: Record<string, RunStatus | Error>, o: { result?: ResultEvent; adapter?: Partial<SandboxRuntime> } = {}) {
  let now = T0;
  const finished: { id: string; exit: unknown; result: unknown }[] = [];
  const rt: SandboxRuntime = {
    name: "cloudrun",
    start: vi.fn(),
    wait: vi.fn(),
    cancel: vi.fn(),
    status: async (h) => {
      const s = statuses[h.externalId.replace("exec-", "")];
      if (s instanceof Error) throw s;
      return s!;
    },
    ...o.adapter,
  };
  const ledger = { activeTasks: async () => tasks, getTask: async (id: string) => tasks.find((t) => t.id === id) } as unknown as Ledger;
  const d: SweepDeps = {
    ledger,
    runtimes: { cloudrun: rt },
    graceMs: 10 * MIN,
    now: () => now,
    cancel: vi.fn(async () => {}),
    collect: async () => o.result,
    finish: async (t, exit, result) => {
      finished.push({ id: t.id, exit, result });
      t.status = exit.reason === "cancelled" ? "cancelled" : "failed";
    },
    log: () => {},
  };
  return { d, finished, advance: (ms: number) => (now += ms) };
}

describe("sweepEndedSandboxes", () => {
  it("closes a task whose sandbox ended more than the grace ago with no result: failed, workflow cancelled", async () => {
    const t = row("ghost");
    const { d, finished } = setup([t], { ghost: { state: "ended", endedAt: iso(T0 - 11 * MIN), exitCode: 0 } });
    expect(await sweepEndedSandboxes(d)).toEqual(["ghost"]);
    expect(d.cancel).toHaveBeenCalledWith("ghost");
    expect(finished).toEqual([{ id: "ghost", exit: { code: 0, reason: "sandbox-ended" }, result: undefined }]);
  });

  it("leaves a sandbox that ended recently alone: the runner's report may still be retrying", async () => {
    const { d, finished } = setup([row("fresh")], { fresh: { state: "ended", endedAt: iso(T0 - 2 * MIN) } });
    expect(await sweepEndedSandboxes(d)).toEqual([]);
    expect(finished).toEqual([]);
  });

  it("leaves running sandboxes, queued tasks, tasks without a handle, and adapters without status() alone", async () => {
    const tasks = [row("running"), row("queued", { status: "queued" }), row("nohandle", { run_handle: null }), row("local", { run_handle: { adapter: "local", externalId: "x" } })];
    const { d, finished } = setup(tasks, { running: { state: "running" } });
    expect(await sweepEndedSandboxes(d)).toEqual([]);
    expect(finished).toEqual([]);
  });

  it("passes along the result when the runner did get one through (a lost workflow, not a lost run)", async () => {
    const result = { runId: "r", seq: 9, ts: "t", type: "result", text: "done it", isError: false } as ResultEvent;
    const { d, finished } = setup([row("late")], { late: { state: "ended", endedAt: iso(T0 - 30 * MIN), exitCode: 0 } }, { result });
    await sweepEndedSandboxes(d);
    expect(finished[0]).toMatchObject({ id: "late", result });
  });

  it("a lost sandbox has no end time: the grace runs from when the sweep first saw it", async () => {
    const { d, finished, advance } = setup([row("lost1")], { lost1: { state: "lost" } });
    expect(await sweepEndedSandboxes(d)).toEqual([]); // first sight
    advance(9 * MIN);
    expect(await sweepEndedSandboxes(d)).toEqual([]);
    advance(2 * MIN);
    expect(await sweepEndedSandboxes(d)).toEqual(["lost1"]);
    expect(finished[0]!.exit).toEqual({ code: 1, reason: "lost" });
  });

  it("a task that finished while the sweep looked is not touched", async () => {
    const t = row("racy");
    const { d, finished } = setup([t], { racy: { state: "ended", endedAt: iso(T0 - 20 * MIN) } });
    const getTask = d.ledger.getTask as unknown as (id: string) => Promise<TaskRow>;
    d.ledger.getTask = (async (id: string) => ({ ...(await getTask(id)), status: "done" })) as never;
    expect(await sweepEndedSandboxes(d)).toEqual([]);
    expect(finished).toEqual([]);
  });

  it("one failing status lookup does not stop the rest", async () => {
    const { d, finished } = setup([row("broken"), row("ghost")], { broken: new Error("api down"), ghost: { state: "ended", endedAt: iso(T0 - 20 * MIN) } });
    expect(await sweepEndedSandboxes(d)).toEqual(["ghost"]);
    expect(finished.map((f) => f.id)).toEqual(["ghost"]);
  });

  it("keeps the platform's reason (e.g. timeout) as the exit reason", async () => {
    const { d, finished } = setup([row("slow")], { slow: { state: "ended", endedAt: iso(T0 - 20 * MIN), exitCode: 137, reason: "timeout" } });
    await sweepEndedSandboxes(d);
    expect(finished[0]!.exit).toEqual({ code: 137, reason: "timeout" });
  });
});
