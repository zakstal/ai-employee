import { loadEmployees } from "../roles/load.js";
import { HttpClickUpClient } from "../clickup/client.js";
import { renderBacklogState } from "../backlogs/render.js";
import { readBacklogState } from "../backlogs/state.js";

/** The state the manager would see for one backlog, read-only. No task history: nothing counts as running or attempted. */
export async function simulateBacklog(dirs: string[], employeeId: string, backlogId: string, githubToken: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string> {
  const employee = (await loadEmployees(dirs)).get(employeeId);
  if (!employee) throw new Error(`unknown employee ${employeeId}`);
  const b = employee.backlogs?.[backlogId];
  if (!b) throw new Error(`employee ${employeeId} has no backlog ${backlogId}`);
  const state = await readBacklogState({ fetch: fetchImpl, clickup: new HttpClickUpClient(process.env.CLICKUP_API_TOKEN ?? ""), githubToken, tasks: async () => [] }, backlogId, b);
  return renderBacklogState([{ id: backlogId, state }]);
}
