import type { Employee, Monitor, TaskInput } from "@ai-employee/core";
import { deps } from "../orchestration/deps.js";
import type { MonitorRow } from "../db/ledger.js";
import { collectAzureErrors } from "./azure.js";
import { collectClickUpChannels } from "./clickup.js";
import { renderEvidence, type CollectResult, type Finding } from "./types.js";

/** Engine-free helpers for the monitor tick (called as steps from the DBOS tick workflow). */

export interface DueMonitor {
  employee: Employee;
  name: string;
  monitor: Monitor;
  row: MonitorRow;
}

/** Enabled monitors whose interval has elapsed. Disabled == no row or enabled=false. */
export async function listDueMonitors(now: Date): Promise<DueMonitor[]> {
  const { employees, ledger } = deps();
  const due: DueMonitor[] = [];
  for (const employee of employees.values()) {
    for (const [name, monitor] of Object.entries(employee.monitors)) {
      const row = await ledger.getMonitor(employee.id, name);
      if (!row?.enabled) continue;
      const elapsed = row.last_run_at ? now.getTime() - row.last_run_at.getTime() : Infinity;
      if (elapsed < monitor.everyMin * 60_000 - 5_000) continue;
      due.push({ employee, name, monitor, row });
    }
  }
  return due;
}

export async function collect(d: DueMonitor, now: Date): Promise<CollectResult> {
  const { config, clickup } = deps();
  switch (d.monitor.collector) {
    case "azure-errors":
      return collectAzureErrors(d.monitor.config, {
        subscriptionId: config.AZURE_SUBSCRIPTION_ID,
        brokerUrl: config.AZURE_BROKER_URL || undefined,
        brokerSecret: config.AZURE_BROKER_SECRET || undefined,
        tenantId: config.AZURE_TENANT_ID || undefined,
        clientId: config.AZURE_CLIENT_ID || undefined,
        clientSecret: config.AZURE_CLIENT_SECRET || undefined,
      }, d.row.state, now);
    case "clickup-channels":
      return collectClickUpChannels(d.monitor.config, clickup, config.CLICKUP_TEAM_ID, d.row.state);
  }
}

/**
 * A broken monitor must be visible, but a single "fetch failed" is a network blip, not news: it cost a triage
 * run on 2026-09-18 and said nothing. Report only once the collector has failed twice in a row, and keep the
 * previous state so the next good run still diffs against real data.
 */
export async function collectSafely(d: DueMonitor, now: Date): Promise<CollectResult> {
  try {
    const r = await collect(d, now);
    return { ...r, state: { ...r.state, collectorFailures: 0 } };
  } catch (err) {
    const failures = Number((d.row.state as { collectorFailures?: number }).collectorFailures ?? 0) + 1;
    const state = { ...d.row.state, collectorFailures: failures };
    if (failures < 2) return { findings: [], state };
    return { findings: [{ key: `collector-error|${d.name}`, text: `Monitor "${d.name}" collector has failed ${failures} runs in a row: ${(err as Error).message}` }], state };
  }
}

export function taskFor(d: DueMonitor, findings: Finding[], now: Date): { taskId: string; input: TaskInput } {
  const { config } = deps();
  const stamp = now.toISOString().slice(0, 16); // minute resolution == dedup key
  const body = findings.map((f) => (f.evidence ? `- ${f.text}\n${renderEvidence(f.evidence)}` : `- ${f.text}`)).join("\n");
  const prompt =
    `Monitor "${d.name}" (${d.monitor.collector}) found ${findings.length} new item(s) at ${now.toISOString()}:\n${body}\n\n` +
    "Carry the evidence block above VERBATIM into anything you create or hand on — the ClickUp task, the " +
    "brief you give a subagent, and the PR description — so every fix states the telemetry it came from and " +
    "a human can re-run the query. Never paraphrase a count or drop the link.";
  const alertTo = config.ALERT_CHANNEL_ID;
  return {
    taskId: `monitor:${d.employee.id}:${d.name}:${stamp}`,
    input: {
      employeeId: d.employee.id,
      roleId: d.monitor.role,
      prompt,
      source: alertTo ? { channel: "clickup-chat", threadRef: alertTo, quiet: true } : { channel: "http", quiet: true },
    },
  };
}

export async function saveRun(d: DueMonitor, state: Record<string, unknown>, now: Date, fired: boolean): Promise<void> {
  await deps().ledger.saveMonitorRun(d.employee.id, d.name, state, now, fired);
}
