import type { Backlog, Employee } from "@ai-employee/core";
import { fill, type BacklogState, type ItemState } from "./state.js";

const src = (b: Backlog): string => (b.source.kind === "repo-file" ? `repo-file ${b.source.repo}@${b.source.ref} ${b.source.path}` : `clickup-list ${b.source.listId}`);

/** The static part, from config: appended to the manager's system prompt. */
export function renderBacklogs(employee: Pick<Employee, "backlogs">): string {
  const entries = Object.entries(employee.backlogs ?? {});
  if (!entries.length) return "";
  const lines = ["## Backlogs (from config)", "", "These are your backlogs. Dispatch only with `spawn_agent(role, brief, backlog, item)` so the system enforces the limits; a 409 reply starting `guard:` means stop dispatching that backlog and report it once."];
  for (const [id, b] of entries) {
    lines.push(
      "",
      `### ${id}${b.enabled ? "" : " (DISABLED: dispatch nothing)"}`,
      ...(b.description ? [b.description] : []),
      `- source: ${src(b)}; order: ${b.order}; phase gate: ${b.phaseGate}`,
      `- dispatch role: ${b.dispatch.role}; concurrency: ${b.concurrency}`,
      `- done when: ${b.source.kind === "clickup-list" ? `status is one of ${b.source.doneStatuses.join(", ")}` : `${b.done.rule} (branch ${b.done.branchPattern}${b.done.base ? `, base ${b.done.base}` : ""})`}`,
      `- guards: ${b.guards.maxTasksPerDay ? `${b.guards.maxTasksPerDay} tasks/day, ` : ""}${b.guards.maxCostUsdPerDay ? `$${b.guards.maxCostUsdPerDay}/day, ` : ""}${b.guards.maxAttemptsPerItem} attempts per item, halt after ${b.guards.stopAfterConsecutiveFailures} consecutive failures`,
      "- brief template (the system fills the placeholders and puts it before your `brief`; use `brief` only for extra notes):",
      ...b.dispatch.brief.trimEnd().split("\n").map((l) => `    ${l}`),
    );
  }
  return lines.join("\n");
}

const item = (i: ItemState, extra = ""): string => `  - ${i.id} (phase ${i.phase}, branch ${i.branch}${i.attempts ? `, attempts ${i.attempts}` : ""})${extra}`;

/** The computed part, per run: appended to the manager's task prompt. `error` replaces the state when the source could not be read. */
export function renderBacklogState(states: { id: string; state?: BacklogState; error?: string; halted?: string; today?: { tasks: number; costUsd: number }; limits?: { maxTasksPerDay: number | null; maxCostUsdPerDay: number | null } }[]): string {
  const lines = ["## Backlog state (computed now by the system; trust it over your memory)"];
  for (const s of states) {
    if (!s.state) {
      lines.push("", `### ${s.id}`, `State unavailable (${s.error ?? "unknown"}). Dispatch nothing for this backlog this run.`);
      continue;
    }
    const st = s.state;
    lines.push("", `### ${s.id}`, `running ${st.running}/${st.concurrency}, free slots ${st.freeSlots}; ${st.done.length}/${st.total} done`);
    if (s.today) lines.push(`today: ${s.today.tasks}${s.limits?.maxTasksPerDay ? `/${s.limits.maxTasksPerDay}` : ""} tasks, $${s.today.costUsd.toFixed(2)}${s.limits?.maxCostUsdPerDay ? ` of $${s.limits.maxCostUsdPerDay}` : ""}`);
    if (!st.enabled) lines.push("DISABLED: dispatch nothing.");
    else if (s.halted) lines.push(`HALTED: ${s.halted}. Dispatch nothing; report it once.`);
    if (st.runningItems.length) lines.push("running:", ...st.runningItems.map((i) => item(i)));
    lines.push(st.ready.length ? "ready (in order):" : "ready: none", ...st.ready.map((i) => item(i, i.lastFailure ? ` last attempt: ${i.lastFailure}` : "")));
    if (st.stopped.length) lines.push("stopped (attempt limit reached; needs a human):", ...st.stopped.map((i) => item(i, ` last: ${i.lastFailure ?? "?"}`)));
    if (st.blocked.length) lines.push(`blocked: ${st.blocked.map((i) => `${i.id} (waits for ${(i.waitingFor ?? []).join(", ")})`).join("; ")}`);
  }
  return lines.join("\n");
}

/** Fill the brief template of a backlog item (what the manager is told to spawn with). */
export function briefFor(id: string, b: Backlog, itemId: string, branch: string): string {
  return fill(b.dispatch.brief, { item: itemId, backlog: id, branch, base: b.done.base ?? (b.source.kind === "repo-file" ? b.source.ref : "") });
}
