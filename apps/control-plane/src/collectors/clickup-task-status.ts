import { z } from "zod";
import type { Finding } from "../monitors/types.js";
import type { Collector } from "./types.js";

const schema = z.object({
  listIds: z.array(z.string().min(1)).min(1),
  /** Report only tasks that enter one of these statuses (case-insensitive). Default: any change. */
  statuses: z.array(z.string().min(1)).optional(),
});

/** A finding when a task of the configured lists enters a status (a task that appears already in one counts). */
export const clickupTaskStatus: Collector<z.infer<typeof schema>> = {
  id: "clickup-task-status",
  configSchema: schema,
  async collect(ctx, config, prev) {
    const first = prev.initialized !== true;
    const before = (prev.tasks ?? {}) as Record<string, string>;
    const tasks: Record<string, string> = {};
    const findings: Finding[] = [];
    const want = config.statuses?.map((s) => s.toLowerCase());
    for (const listId of config.listIds) {
      for (const t of await ctx.clickup.listTasks(listId)) {
        const status = (t.status?.status ?? "").toLowerCase();
        tasks[t.id] = status;
        if (first || before[t.id] === status || (want && !want.includes(status))) continue;
        findings.push({
          key: `clickup-status|${t.id}|${status}`,
          text: `${t.name} (${t.id}) ${before[t.id] ? `moved ${before[t.id]} -> ${status}` : `is ${status}`}`,
          evidence: { source: `ClickUp list ${listId}`, observed: `task ${t.id} status ${status}`, ...(t.url ? { url: t.url } : {}) },
        });
      }
    }
    return { findings, state: { initialized: true, tasks } };
  },
};
