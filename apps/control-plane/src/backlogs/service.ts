import { resolveRole, type Employee } from "@ai-employee/core";
import { resolveGrantEnv } from "../credentials/index.js";
import { deps } from "../orchestration/deps.js";
import { renderBacklogState } from "./render.js";
import { readBacklogState, type BacklogState } from "./state.js";

/** Computed state of one configured backlog, read with the backlog's own credential. Throws if the source cannot be read. */
export async function computeBacklogState(employee: Employee, backlogId: string): Promise<BacklogState> {
  const { config, ledger, clickup, secrets } = deps();
  const b = employee.backlogs?.[backlogId];
  if (!b) throw new Error(`employee ${employee.id} has no backlog ${backlogId}`);
  const env = await resolveGrantEnv({ employee, role: resolveRole(employee, b.dispatch.role), taskId: `backlog:${backlogId}`, config, secrets, fetch, now: () => new Date() }, [b.credential]);
  return readBacklogState({ fetch, clickup, githubToken: env.GH_TOKEN ?? env.GITHUB_TOKEN, tasks: () => ledger.tasksByBacklog(employee.id, backlogId) }, backlogId, b);
}

/** Text for the manager's task prompt: every enabled-or-not backlog's state, or why it could not be read. Never throws. */
export async function backlogPromptState(employee: Employee): Promise<string> {
  const ids = Object.keys(employee.backlogs ?? {});
  if (!ids.length) return "";
  const states = await Promise.all(
    ids.map(async (id) => {
      // A disabled backlog is not read at all (no GitHub calls, no failures for a source that may not exist yet).
      if (!employee.backlogs![id]!.enabled) return { id, error: "disabled in config" };
      try {
        return { id, state: await computeBacklogState(employee, id) };
      } catch (e) {
        return { id, error: (e as Error).message.slice(0, 200) };
      }
    }),
  );
  return renderBacklogState(states);
}
