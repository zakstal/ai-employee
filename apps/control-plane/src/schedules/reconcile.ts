import { createHash } from "node:crypto";
import type { Employee } from "@ai-employee/core";
import type { Ledger } from "../db/ledger.js";
import { nextFire, validateCron } from "./cron.js";

export interface ReconcileOptions {
  ledger: Ledger;
  employees: Map<string, Employee>;
  defaultTz: string;
  now?: Date;
  log?: (msg: string) => void;
}

/**
 * Make the `schedules` table match the `schedules:` blocks of the employee files. Config rows that left the file
 * are deleted; runtime rows are untouched, except that a same-name runtime row is converted (config wins).
 * An unchanged definition is not rewritten, so next_fire_at / last_fired_at survive restarts.
 * Call only from the control plane that owns the tick (TICK_ENABLED).
 */
export async function reconcileSchedules(o: ReconcileOptions): Promise<void> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  for (const e of o.employees.values()) {
    const defs = Object.entries(e.schedules ?? {});
    for (const [name, s] of defs) {
      const timezone = s.timezone ?? o.defaultTz;
      const bad = scheduleProblem(e, name, s.cron, timezone, s.role);
      if (bad) throw new Error(bad);
      const prompt = s.prompt!;
      const hash = createHash("sha256").update(JSON.stringify({ cron: s.cron, timezone, role: s.role, prompt, deliverTo: s.deliverTo, enabled: s.enabled })).digest("hex");
      const wrote = await o.ledger.upsertConfigSchedule({
        employeeId: e.id, name, cron: s.cron, timezone, roleId: s.role, prompt, deliverTo: s.deliverTo, enabled: s.enabled,
        nextFireAt: nextFire(s.cron, timezone, now), hash,
      });
      if (wrote) log(`schedule ${e.id}/${name} reconciled from config`);
    }
    const removed = await o.ledger.deleteConfigSchedulesNotIn(e.id, defs.map(([n]) => n));
    if (removed) log(`schedule ${e.id}: removed ${removed} config schedule(s) no longer in the file`);
  }
}

/** A message when the schedule can't run (bad cron/zone, cadence under 15 min, unknown role), else undefined. Shared with `config check`. */
export function scheduleProblem(e: Pick<Employee, "id" | "roles">, name: string, cron: string, timezone: string, role: string): string | undefined {
  const c = validateCron(cron, timezone);
  if (!c.ok) return `${e.id}: schedule ${name}: ${c.error}`;
  if (!e.roles.some((r) => r.id === role)) return `${e.id}: schedule ${name} names unknown role "${role}"`;
  return undefined;
}
