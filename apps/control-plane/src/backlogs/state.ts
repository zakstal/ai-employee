import type { Backlog } from "@ai-employee/core";
import type { ClickUpClient } from "../clickup/client.js";
import { ghGet, ghList } from "../github-api.js";
import { parseTaskList, slug, type TaskListItem } from "./task-list.js";

export interface BacklogTaskRow {
  id: string;
  status: string;
  item: string | null;
  text: string | null;
  createdAt: Date;
}

export interface StateDeps {
  fetch: typeof fetch;
  clickup: ClickUpClient;
  /** Token for the GitHub API (repo-file sources). */
  githubToken?: string | undefined;
  /** Tasks the ledger holds for this backlog, oldest first. */
  tasks(): Promise<BacklogTaskRow[]>;
}

export type ItemStatus = "done" | "running" | "stopped" | "blocked" | "ready";
export interface ItemState {
  id: string;
  title: string;
  phase: number;
  status: ItemStatus;
  branch: string;
  attempts: number;
  /** Last failed or unfinished attempt, kept so the manager can say why an item stopped. */
  lastFailure?: string;
  waitingFor?: string[];
}

export interface BacklogState {
  backlogId: string;
  enabled: boolean;
  total: number;
  running: number;
  concurrency: number;
  freeSlots: number;
  ready: ItemState[];
  done: ItemState[];
  stopped: ItemState[];
  blocked: ItemState[];
  runningItems: ItemState[];
}

const ACTIVE = new Set(["queued", "running", "awaiting_input"]);

export const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);

interface Pr {
  head: { ref: string };
  state: string;
  merged_at: string | null;
}

const gh = (d: StateDeps, path: string, accept?: string) => ghGet(d.fetch, d.githubToken, path, accept);
const ghPages = <T>(d: StateDeps, path: string) => ghList<T>(d.fetch, d.githubToken, path);

interface Source {
  items: TaskListItem[];
  /** item id -> its PR or branch, per the done rule, when the source is a repo. */
  prs: Map<string, { open: boolean; merged: boolean }>;
  branches: Set<string>;
}

async function readSource(d: StateDeps, b: Backlog, branchOf: (id: string) => string): Promise<Source> {
  const src = b.source;
  if (src.kind === "clickup-list") {
    const done = new Set(src.doneStatuses.map((s) => s.toLowerCase()));
    const items = (await d.clickup.listTasks(src.listId)).map((t) => ({ id: t.id, title: t.name, phase: 1, checked: done.has((t.status?.status ?? "").toLowerCase()), depends: [] }));
    return { items, prs: new Map(), branches: new Set() };
  }
  const raw = await (await gh(d, `/repos/${src.repo}/contents/${src.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(src.ref)}`, "application/vnd.github.raw+json")).text();
  const items = parseTaskList(raw);
  const prs = new Map<string, { open: boolean; merged: boolean }>();
  const branches = new Set<string>();
  if (b.done.rule === "branch-pushed") {
    for (const br of await ghPages<{ name: string }>(d, `/repos/${src.repo}/branches`)) branches.add(br.name);
  } else {
    const base = b.done.base ?? src.ref;
    const byBranch = new Map(items.map((i) => [branchOf(i.id), i.id]));
    for (const pr of await ghPages<Pr>(d, `/repos/${src.repo}/pulls?state=all&base=${encodeURIComponent(base)}`)) {
      const id = byBranch.get(pr.head.ref);
      if (!id) continue;
      const prev = prs.get(id) ?? { open: false, merged: false };
      prs.set(id, { open: prev.open || pr.state === "open", merged: prev.merged || pr.merged_at !== null });
    }
  }
  return { items, prs, branches };
}

/**
 * What the manager sees: each item is done, running, stopped, blocked or ready. Deterministic, no model.
 * Truth is the source (checkbox, PR, branch) plus the ledger's tasks; a task's own report is never trusted.
 */
export async function readBacklogState(d: StateDeps, backlogId: string, b: Backlog): Promise<BacklogState> {
  const branchOf = (id: string) => fill(b.done.branchPattern, { backlog: backlogId, item: id });
  const [source, tasks] = await Promise.all([readSource(d, b, branchOf), d.tasks()]);

  const isDone = (i: TaskListItem): boolean => {
    if (i.checked) return true;
    const pr = source.prs.get(i.id);
    if (b.done.rule === "branch-pushed") return source.branches.has(branchOf(i.id));
    return b.done.rule === "pr-merged" ? !!pr?.merged : !!pr && (pr.open || pr.merged);
  };
  // For the phase gate only a merged PR (or a checked box) counts, whatever the done rule says.
  const isMerged = (i: TaskListItem): boolean => i.checked || !!source.prs.get(i.id)?.merged;

  const ordered = b.order === "phase" ? [...source.items].sort((x, y) => x.phase - y.phase) : source.items; // sort is stable: file order within a phase
  const byId = new Map(source.items.map((i) => [i.id, i]));
  const state: BacklogState = { backlogId, enabled: b.enabled, total: ordered.length, running: 0, concurrency: b.concurrency, freeSlots: 0, ready: [], done: [], stopped: [], blocked: [], runningItems: [] };

  for (const i of ordered) {
    const mine = tasks.filter((t) => t.item === i.id);
    const active = mine.filter((t) => ACTIVE.has(t.status));
    const finished = mine.filter((t) => !ACTIVE.has(t.status));
    const last = finished[finished.length - 1];
    const item: ItemState = {
      id: i.id, title: i.title, phase: i.phase, status: "ready", branch: branchOf(i.id), attempts: finished.length,
      ...(last && last.status !== "done" ? { lastFailure: (last.text ?? last.status).slice(0, 200) } : last ? { lastFailure: "finished without a PR or branch the done rule accepts" } : {}),
    };
    const waiting = i.depends.filter((dep) => { const x = byId.get(dep); return x && !isDone(x); });
    if (b.phaseGate === "merged" && source.items.some((o) => o.phase < i.phase && !isMerged(o))) waiting.push(`phase ${i.phase - 1}`);
    if (isDone(i)) item.status = "done";
    else if (active.length) item.status = "running";
    else if (item.attempts >= b.guards.maxAttemptsPerItem) item.status = "stopped";
    else if (waiting.length) {
      item.status = "blocked";
      item.waitingFor = waiting;
    }
    ({ done: state.done, running: state.runningItems, stopped: state.stopped, blocked: state.blocked, ready: state.ready })[item.status].push(item);
  }
  // Running counts tasks, including ones whose item left the file.
  state.running = tasks.filter((t) => ACTIVE.has(t.status)).length;
  state.freeSlots = Math.max(0, b.concurrency - state.running);
  return state;
}

export { slug };
