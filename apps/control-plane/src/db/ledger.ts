import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { retryTransient } from "./retry.js";
import type { RunHandle, RunnerEvent, TaskInput, TaskStatus } from "@ai-employee/core";
import type { AccountUsage } from "../claude/usage.js";

export interface DeliverTo {
  channel: string;
  threadRef: string;
}

export interface ScheduleRow {
  id: string;
  employee_id: string;
  name: string;
  cron: string;
  timezone: string;
  role_id: string;
  prompt: string;
  deliver_to: DeliverTo;
  created_by_task: string | null;
  enabled: boolean;
  last_fired_at: Date | null;
  next_fire_at: Date;
  created_at: Date;
  /** 'runtime' (agent-created) or 'config' (reconciled from the employee file). */
  source: "runtime" | "config";
  config_hash: string | null;
}

export interface MonitorRow {
  employee_id: string;
  name: string;
  enabled: boolean;
  state: Record<string, unknown>;
  last_run_at: Date | null;
  last_fired_at: Date | null;
  updated_by_task: string | null;
  updated_at: Date;
}

export interface CreateScheduleInput {
  employeeId: string;
  name: string;
  cron: string;
  timezone: string;
  roleId: string;
  prompt: string;
  deliverTo: DeliverTo;
  createdByTask?: string;
  nextFireAt: Date;
}

export interface StatsBucket {
  tasks: number;
  done: number;
  failed: number;
  cancelled: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  numTurns: number;
}
export interface StatsByDay extends StatsBucket {
  day: string;
}
export interface StatsByRole extends StatsBucket {
  role: string;
}
export interface StatsByChannel extends StatsBucket {
  channel: string;
}
export interface StatsTopTask {
  id: string;
  role: string;
  channel: string;
  costUsd: number;
  numTurns: number;
  status: string;
  prompt: string;
}
export interface Stats {
  since: string;
  until: string;
  totals: StatsBucket;
  byDay: StatsByDay[];
  byRole: StatsByRole[];
  byChannel: StatsByChannel[];
  topTasks: StatsTopTask[];
}

export interface AgentMessageRow {
  id: number;
  employee_id: string;
  channel: string;
  from_task_id: string;
  to_task_id: string | null;
  body: { role: "agent"; messageId: string; contextId: string; parts: { kind: "text"; text: string }[] };
  created_at: Date;
}

export interface OwnerNoteRow {
  id: string; // bigserial arrives as a string
  employee_id: string;
  from_task_id: string | null;
  role_id: string | null;
  text: string;
  created_at: Date;
  acked_at: Date | null;
}

export interface TaskRow {
  id: string;
  employee_id: string;
  conversation_id: string | null;
  role_id: string;
  prompt: string;
  source: TaskInput["source"];
  status: TaskStatus;
  run_handle: RunHandle | null;
  result: unknown;
  parent_task_id: string | null;
  depth: number;
  question: string | null;
  answer: string | null;
  /** Claude subscription account the run authenticates with (name only). */
  claude_account: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Plain SQL over the shared ledger. Engine-free; called from workflow steps and HTTP handlers. */
export class Ledger {
  constructor(private db: pg.Pool) {}

  async ensureEmployee(id: string, name: string): Promise<void> {
    await this.db.query("INSERT INTO employees (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [id, name]);
  }

  async upsertConversation(employeeId: string, channel: string, externalRef: string): Promise<string> {
    const r = await retryTransient(() => this.db.query<{ id: string }>(
      `INSERT INTO conversations (employee_id, channel, external_ref) VALUES ($1,$2,$3)
       ON CONFLICT (channel, external_ref) DO UPDATE SET external_ref = EXCLUDED.external_ref
       RETURNING id`,
      [employeeId, channel, externalRef],
    ));
    return r.rows[0]!.id;
  }

  /** The session to resume for a message handled by `roleId`: null unless that same role created it (session_role). */
  async getConversationSession(conversationId: string, roleId: string): Promise<string | null> {
    const r = await this.db.query<{ session_id: string | null }>("SELECT session_id FROM conversations WHERE id = $1 AND session_role = $2", [conversationId, roleId]);
    return r.rows[0]?.session_id ?? null;
  }

  async setConversationSession(conversationId: string, sessionId: string, roleId: string): Promise<void> {
    await this.db.query("UPDATE conversations SET session_id = $2, session_role = $3 WHERE id = $1", [conversationId, sessionId, roleId]);
  }

  /**
   * Returns false if the task already existed (dedup). Retried once on a dropped connection: the id makes the insert idempotent.
   * ponytail: if the first attempt committed but its reply was lost, the retry reports "existed" and the workflow is not started;
   * the task sits queued. Fix properly with a started flag on the row if it ever shows up.
   */
  async createTask(id: string, input: TaskInput): Promise<boolean> {
    const r = await retryTransient(() => this.db.query(
      `INSERT INTO tasks (id, employee_id, conversation_id, role_id, prompt, source, parent_task_id, depth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        input.employeeId,
        input.source.conversationId ?? null,
        input.roleId,
        input.prompt,
        JSON.stringify(input.source),
        input.source.parentTaskId ?? null,
        input.source.depth ?? 0,
      ],
    ));
    return (r.rowCount ?? 0) > 0;
  }

  async setStatus(id: string, status: TaskStatus, extra: { runHandle?: RunHandle; result?: unknown } = {}): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET status = $2,
         run_handle = COALESCE($3::jsonb, run_handle),
         result = COALESCE($4::jsonb, result),
         updated_at = now()
       WHERE id = $1`,
      [id, status, extra.runHandle ? JSON.stringify(extra.runHandle) : null, extra.result !== undefined ? JSON.stringify(extra.result) : null],
    );
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    const r = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    return r.rows[0];
  }

  // ---- notes for the owner's local session
  async addOwnerNote(n: { employeeId: string; fromTaskId: string; roleId: string; text: string }): Promise<string> {
    const r = await this.db.query<{ id: string }>("INSERT INTO owner_notes (employee_id, from_task_id, role_id, text) VALUES ($1,$2,$3,$4) RETURNING id", [n.employeeId, n.fromTaskId, n.roleId, n.text]);
    return r.rows[0]!.id;
  }

  async countOwnerNotesFromTask(taskId: string): Promise<number> {
    const r = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM owner_notes WHERE from_task_id = $1", [taskId]);
    return Number(r.rows[0]!.n);
  }

  /** Notes after `since` (id), oldest first. Acknowledged ones only when `includeAcked`. */
  async listOwnerNotes(o: { since: number; includeAcked: boolean; employeeId?: string; limit: number }): Promise<OwnerNoteRow[]> {
    const r = await this.db.query<OwnerNoteRow>(
      `SELECT * FROM owner_notes WHERE id > $1 ${o.includeAcked ? "" : "AND acked_at IS NULL"} ${o.employeeId ? "AND employee_id = $3" : ""}
       ORDER BY id LIMIT $2`,
      o.employeeId ? [o.since, o.limit, o.employeeId] : [o.since, o.limit],
    );
    return r.rows;
  }

  /** Idempotent: a second ack keeps the first time. Undefined when there is no such note. */
  async ackOwnerNote(id: number): Promise<OwnerNoteRow | undefined> {
    const r = await this.db.query<OwnerNoteRow>("UPDATE owner_notes SET acked_at = COALESCE(acked_at, now()) WHERE id = $1 RETURNING *", [id]);
    return r.rows[0];
  }

  // ---- child agents
  /**
   * Every agent spawned anywhere in a conversation. Each chat message is its own task, so scoping agent
   * lookups to the calling task hides children spawned while answering an earlier message — the resumed
   * session remembers dispatching them and then cannot find them ("the agent silently dropped").
   */
  async listConversationAgents(conversationId: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      "SELECT * FROM tasks WHERE conversation_id = $1 AND parent_task_id IS NOT NULL ORDER BY created_at",
      [conversationId],
    );
    return r.rows;
  }

  async listChildren(parentId: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE parent_task_id = $1 ORDER BY created_at DESC", [parentId]);
    return r.rows;
  }

  async countActiveChildren(parentId: string): Promise<number> {
    const r = await this.db.query<{ count: string }>(
      "SELECT count(*) FROM tasks WHERE parent_task_id = $1 AND status IN ('queued','running','awaiting_input')",
      [parentId],
    );
    return Number(r.rows[0]!.count);
  }

  async setQuestion(id: string, question: string): Promise<void> {
    await this.db.query("UPDATE tasks SET question = $2, updated_at = now() WHERE id = $1", [id, question]);
  }

  async answerTask(id: string, answer: string): Promise<void> {
    await this.db.query("UPDATE tasks SET answer = $2, updated_at = now() WHERE id = $1", [id, answer]);
  }

  /** Returns and clears the pending answer (and its question); undefined if none is set yet.
   *  `RETURNING answer` alone would return the post-update (NULL) value, so the prior value is
   *  captured in a CTE evaluated against the pre-update snapshot. */
  async takeAnswer(id: string): Promise<string | undefined> {
    const r = await this.db.query<{ answer: string }>(
      `WITH prior AS (SELECT answer FROM tasks WHERE id = $1 AND answer IS NOT NULL)
       UPDATE tasks SET answer = NULL, question = NULL
       WHERE id = $1 AND answer IS NOT NULL
       RETURNING (SELECT answer FROM prior) AS answer`,
      [id],
    );
    return r.rows[0]?.answer;
  }

  /** Most recent awaiting_input task whose stored source threadRef matches — covers a direct human-triggered
   *  task (source.channel === channel) and a child that asked (source.channel === "child" but inherited threadRef). */
  async findAwaitingInThread(channel: string, threadRef: string): Promise<TaskRow | undefined> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'awaiting_input' AND source->>'threadRef' = $2
         AND (source->>'channel' = $1 OR source->>'channel' = 'child')
       ORDER BY created_at DESC LIMIT 1`,
      [channel, threadRef],
    );
    return r.rows[0];
  }

  async listTasks(employeeId: string, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE employee_id = $1
         ${opts.activeOnly ? "AND status IN ('queued','running','awaiting_input')" : ""}
       ORDER BY created_at DESC LIMIT $2`,
      [employeeId, opts.limit ?? 50],
    );
    return r.rows;
  }

  // ---- live status page
  /** Every not-yet-terminal task, optionally scoped to one employee. */
  async activeTasks(employeeId?: string): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      `SELECT * FROM tasks WHERE status IN ('queued','running','awaiting_input')
         ${employeeId ? "AND employee_id = $1" : ""}
       ORDER BY created_at DESC`,
      employeeId ? [employeeId] : [],
    );
    return r.rows;
  }

  /** Every task created since `since` (terminal or not) — the status page's rolling window. */
  async recentTasks(since: Date): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>("SELECT * FROM tasks WHERE created_at >= $1 ORDER BY created_at DESC", [since]);
    return r.rows;
  }

  /** Idempotent on (task_id, seq). Returns false on duplicate. */
  async appendEvent(ev: RunnerEvent): Promise<boolean> {
    const r = await this.db.query(
      "INSERT INTO task_events (task_id, seq, type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, seq) DO NOTHING",
      [ev.runId, ev.seq, ev.type, JSON.stringify(ev)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async listEvents(taskId: string): Promise<RunnerEvent[]> {
    const r = await this.db.query<{ payload: RunnerEvent }>("SELECT payload FROM task_events WHERE task_id = $1 ORDER BY seq", [taskId]);
    return r.rows.map((x) => x.payload);
  }

  /** Latest assistant_text (the "what is it doing now" line) and the cost from the result event, per task. Running tasks have no cost: the harness reports it once, at the end. */
  async taskProgress(taskIds: string[]): Promise<Map<string, { text?: string; costUsd?: number }>> {
    const out = new Map<string, { text?: string; costUsd?: number }>();
    if (taskIds.length === 0) return out;
    const text = await this.db.query<{ task_id: string; text: string }>(
      `SELECT DISTINCT ON (task_id) task_id, payload->>'text' AS text FROM task_events
         WHERE task_id = ANY($1) AND type = 'assistant_text' ORDER BY task_id, seq DESC`,
      [taskIds],
    );
    for (const r of text.rows) out.set(r.task_id, { text: r.text });
    const cost = await this.db.query<{ task_id: string; cost: number | null }>(
      `SELECT task_id, SUM((payload->>'costUsd')::float8) AS cost FROM task_events
         WHERE task_id = ANY($1) AND type = 'result' GROUP BY task_id`,
      [taskIds],
    );
    for (const r of cost.rows) if (r.cost !== null) out.set(r.task_id, { ...out.get(r.task_id), costUsd: r.cost });
    return out;
  }

  /** Tasks of one employee that reached a terminal state since `since`, most recently finished first. */
  async finishedTasksSince(employeeId: string, since: Date, limit: number): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      "SELECT * FROM tasks WHERE employee_id = $1 AND status IN ('done','failed','cancelled') AND updated_at >= $2 ORDER BY updated_at DESC LIMIT $3",
      [employeeId, since, limit],
    );
    return r.rows;
  }

  // ---- agent-to-agent messages (A2A Message shape in `body`)
  async addMessage(m: { employeeId: string; channel: string; fromTaskId: string; toTaskId?: string | undefined; text: string }): Promise<number> {
    const messageId = randomBase62(16);
    const body = { role: "agent", messageId, contextId: m.channel, parts: [{ kind: "text", text: m.text }] };
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO agent_messages (employee_id, channel, from_task_id, to_task_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [m.employeeId, m.channel, m.fromTaskId, m.toTaskId ?? null, JSON.stringify(body)],
    );
    return Number(r.rows[0]!.id);
  }

  /** Messages on a channel after `since`, addressed to everyone or to `taskId`, never the caller's own. Oldest first. */
  async listMessages(employeeId: string, channel: string, taskId: string, since: number, limit = 100): Promise<AgentMessageRow[]> {
    const r = await this.db.query<AgentMessageRow & { id: string }>(
      `SELECT * FROM agent_messages
       WHERE employee_id = $1 AND channel = $2 AND id > $3 AND from_task_id <> $4 AND (to_task_id IS NULL OR to_task_id = $4)
       ORDER BY id LIMIT $5`,
      [employeeId, channel, since, taskId, limit],
    );
    return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
  }

  // ---- Claude accounts: settings, usage, per-task account
  async getSetting<T>(key: string): Promise<T | undefined> {
    const r = await this.db.query<{ value: T }>("SELECT value FROM engine_settings WHERE key = $1", [key]);
    return r.rows[0]?.value;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      "INSERT INTO engine_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, JSON.stringify(value)],
    );
  }

  async setTaskClaudeAccount(taskId: string, account: string): Promise<void> {
    await this.db.query("UPDATE tasks SET claude_account = $2 WHERE id = $1", [taskId, account]);
  }

  /** A probe that read headers replaces the account's usage; one that failed only records last_error and keeps the last good numbers. */
  async saveAccountUsage(u: AccountUsage): Promise<void> {
    if (u.lastError !== undefined && u.fiveHour.status === undefined && u.fiveHour.utilization === undefined && u.sevenDay.utilization === undefined) {
      await this.db.query(
        `INSERT INTO claude_account_usage (name, fingerprint, checked_at, last_error) VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, checked_at = EXCLUDED.checked_at, last_error = EXCLUDED.last_error`,
        [u.name, u.fingerprint, u.checkedAt ?? new Date(), u.lastError],
      );
      return;
    }
    await this.db.query(
      `INSERT INTO claude_account_usage (name, fingerprint, unified_status, representative_claim,
         five_hour_status, five_hour_utilization, five_hour_reset, seven_day_status, seven_day_utilization, seven_day_reset,
         overage_status, overage_utilization, overage_reset, overage_disabled_reason, overage_in_use, checked_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (name) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, unified_status = EXCLUDED.unified_status,
         representative_claim = EXCLUDED.representative_claim, five_hour_status = EXCLUDED.five_hour_status,
         five_hour_utilization = EXCLUDED.five_hour_utilization, five_hour_reset = EXCLUDED.five_hour_reset,
         seven_day_status = EXCLUDED.seven_day_status, seven_day_utilization = EXCLUDED.seven_day_utilization,
         seven_day_reset = EXCLUDED.seven_day_reset, overage_status = EXCLUDED.overage_status,
         overage_utilization = EXCLUDED.overage_utilization, overage_reset = EXCLUDED.overage_reset,
         overage_disabled_reason = EXCLUDED.overage_disabled_reason, overage_in_use = EXCLUDED.overage_in_use, checked_at = EXCLUDED.checked_at, last_error = EXCLUDED.last_error`,
      [
        u.name, u.fingerprint, u.unifiedStatus ?? null, u.representativeClaim ?? null,
        u.fiveHour.status ?? null, u.fiveHour.utilization ?? null, u.fiveHour.reset ?? null,
        u.sevenDay.status ?? null, u.sevenDay.utilization ?? null, u.sevenDay.reset ?? null,
        u.overage.status ?? null, u.overage.utilization ?? null, u.overage.reset ?? null, u.overage.disabledReason ?? null, u.overage.inUse ?? null,
        u.checkedAt ?? new Date(), u.lastError ?? null,
      ],
    );
  }

  /** A task ended on the limit message: mark that window rejected until its reset, leaving the rest of the row alone. */
  async markAccountLimited(name: string, fingerprint: string, window: "5h" | "7d", reset: Date | undefined, at: Date): Promise<void> {
    const col = window === "5h" ? "five_hour" : "seven_day";
    await this.db.query(
      `INSERT INTO claude_account_usage (name, fingerprint, ${col}_status, ${col}_utilization, ${col}_reset, checked_at)
       VALUES ($1,$2,'rejected',1,$3,$4)
       ON CONFLICT (name) DO UPDATE SET ${col}_status = 'rejected', ${col}_utilization = 1,
         ${col}_reset = COALESCE($3, claude_account_usage.${col}_reset), checked_at = $4`,
      [name, fingerprint, reset ?? null, at],
    );
  }

  async listAccountUsage(): Promise<AccountUsage[]> {
    const r = await this.db.query<Record<string, unknown>>("SELECT * FROM claude_account_usage ORDER BY name");
    const d = (v: unknown): Date | undefined => (v instanceof Date ? v : undefined);
    const n = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
    const t = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return r.rows.map((x) => ({
      name: x.name as string,
      fingerprint: x.fingerprint as string,
      unifiedStatus: t(x.unified_status),
      representativeClaim: t(x.representative_claim),
      fiveHour: { status: t(x.five_hour_status), utilization: n(x.five_hour_utilization), reset: d(x.five_hour_reset) },
      sevenDay: { status: t(x.seven_day_status), utilization: n(x.seven_day_utilization), reset: d(x.seven_day_reset) },
      overage: { status: t(x.overage_status), utilization: n(x.overage_utilization), reset: d(x.overage_reset), disabledReason: t(x.overage_disabled_reason), inUse: typeof x.overage_in_use === "boolean" ? x.overage_in_use : undefined },
      checkedAt: d(x.checked_at),
      lastError: t(x.last_error),
    }));
  }

  /** Window alerts already sent: account -> reset time of the 5h / 7d window alerted for. */
  async alertedWindows(): Promise<Map<string, { fiveHour?: Date; sevenDay?: Date }>> {
    const r = await this.db.query<{ name: string; a5: Date | null; a7: Date | null }>("SELECT name, alerted_five_hour_reset AS a5, alerted_seven_day_reset AS a7 FROM claude_account_usage");
    return new Map(r.rows.map((x) => [x.name, { ...(x.a5 ? { fiveHour: x.a5 } : {}), ...(x.a7 ? { sevenDay: x.a7 } : {}) }]));
  }

  async markWindowAlerted(name: string, window: "5h" | "7d", reset: Date): Promise<void> {
    const col = window === "5h" ? "alerted_five_hour_reset" : "alerted_seven_day_reset";
    await this.db.query(`UPDATE claude_account_usage SET ${col} = $2 WHERE name = $1`, [name, reset]);
  }

  // ---- per-run bearer tokens for the event sink
  async issueRunToken(taskId: string, ttlSec: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.db.query("INSERT INTO run_tokens (token_hash, task_id, expires_at) VALUES ($1,$2, now() + ($3 || ' seconds')::interval)", [
      hashToken(token),
      taskId,
      String(ttlSec),
    ]);
    return token;
  }

  async verifyRunToken(taskId: string, token: string): Promise<boolean> {
    const r = await this.db.query("SELECT 1 FROM run_tokens WHERE token_hash = $1 AND task_id = $2 AND expires_at > now()", [hashToken(token), taskId]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---- schedules
  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRow> {
    const id = `sch_${randomBase62(12)}`;
    const r = await this.db.query<ScheduleRow>(
      `INSERT INTO schedules (id, employee_id, name, cron, timezone, role_id, prompt, deliver_to, created_by_task, next_fire_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, input.employeeId, input.name, input.cron, input.timezone, input.roleId, input.prompt, JSON.stringify(input.deliverTo), input.createdByTask ?? null, input.nextFireAt],
    );
    return r.rows[0]!;
  }

  /**
   * Insert or update a schedule defined in config. An unchanged definition (same hash) is a no-op, so
   * last_fired_at / next_fire_at survive restarts. A same-name runtime row becomes a config row. Returns true if written.
   */
  async upsertConfigSchedule(input: Omit<CreateScheduleInput, "createdByTask"> & { enabled: boolean; hash: string }): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO schedules (id, employee_id, name, cron, timezone, role_id, prompt, deliver_to, enabled, next_fire_at, source, config_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'config',$11)
       ON CONFLICT (employee_id, name) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, role_id = EXCLUDED.role_id,
         prompt = EXCLUDED.prompt, deliver_to = EXCLUDED.deliver_to, enabled = EXCLUDED.enabled, next_fire_at = EXCLUDED.next_fire_at,
         source = 'config', config_hash = EXCLUDED.config_hash
       WHERE schedules.config_hash IS DISTINCT FROM EXCLUDED.config_hash OR schedules.source <> 'config'`,
      [`sch_${randomBase62(12)}`, input.employeeId, input.name, input.cron, input.timezone, input.roleId, input.prompt, JSON.stringify(input.deliverTo), input.enabled, input.nextFireAt, input.hash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Delete config-sourced schedules of the employee whose name is not in `names`. Runtime rows are never touched. */
  async deleteConfigSchedulesNotIn(employeeId: string, names: string[]): Promise<number> {
    const r = await this.db.query("DELETE FROM schedules WHERE employee_id = $1 AND source = 'config' AND name <> ALL($2::text[])", [employeeId, names]);
    return r.rowCount ?? 0;
  }

  async listSchedules(employeeId: string): Promise<ScheduleRow[]> {
    const r = await this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE employee_id = $1 ORDER BY created_at DESC", [employeeId]);
    return r.rows;
  }

  async getSchedule(id: string): Promise<ScheduleRow | undefined> {
    const r = await this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE id = $1", [id]);
    return r.rows[0];
  }

  /** Returns false if no matching row (wrong id, or not owned by employeeId). */
  async deleteSchedule(id: string, employeeId: string): Promise<boolean> {
    const r = await this.db.query("DELETE FROM schedules WHERE id = $1 AND employee_id = $2", [id, employeeId]);
    return (r.rowCount ?? 0) > 0;
  }

  async dueSchedules(now: Date): Promise<ScheduleRow[]> {
    const r = await this.db.query<ScheduleRow>("SELECT * FROM schedules WHERE enabled AND next_fire_at <= $1 ORDER BY next_fire_at", [now]);
    return r.rows;
  }

  async markFired(id: string, firedAt: Date, nextFireAt: Date): Promise<void> {
    await this.db.query("UPDATE schedules SET last_fired_at = $2, next_fire_at = $3 WHERE id = $1", [id, firedAt, nextFireAt]);
  }

  /** Recent tasks for ONE employee, newest first — what the manager reads to see what actually ran.
   *  Distinct from recentTasks(since), which is fleet-wide for the status page. */
  async recentTasksForEmployee(employeeId: string, since: Date, limit: number): Promise<TaskRow[]> {
    const r = await this.db.query<TaskRow>(
      "SELECT * FROM tasks WHERE employee_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3",
      [employeeId, since, limit],
    );
    return r.rows;
  }

  // ---- backlogs
  /** Tasks the manager dispatched for a backlog, oldest first. */
  async tasksByBacklog(employeeId: string, backlogId: string): Promise<{ id: string; status: TaskStatus; item: string | null; text: string | null; createdAt: Date }[]> {
    const r = await this.db.query<{ id: string; status: TaskStatus; item: string | null; text: string | null; created_at: Date }>(
      "SELECT id, status, source->>'backlogItem' AS item, result->>'text' AS text, created_at FROM tasks WHERE employee_id = $1 AND source->>'backlogId' = $2 ORDER BY created_at",
      [employeeId, backlogId],
    );
    return r.rows.map((x) => ({ id: x.id, status: x.status, item: x.item, text: x.text, createdAt: x.created_at }));
  }

  async countActiveByBacklog(employeeId: string, backlogId: string): Promise<number> {
    const r = await this.db.query<{ count: string }>(
      "SELECT count(*) FROM tasks WHERE employee_id = $1 AND source->>'backlogId' = $2 AND status IN ('queued','running','awaiting_input')",
      [employeeId, backlogId],
    );
    return Number(r.rows[0]!.count);
  }

  /** Tasks started since `since` and the cost the finished ones reported (the harness's notional USD; a running task counts 0 until it ends). */
  async backlogUsageSince(employeeId: string, backlogId: string, since: Date): Promise<{ tasks: number; costUsd: number }> {
    const r = await this.db.query<{ tasks: number; cost: number }>(
      "SELECT count(*)::int AS tasks, COALESCE(SUM((result->>'costUsd')::numeric), 0)::float8 AS cost FROM tasks WHERE employee_id = $1 AND source->>'backlogId' = $2 AND created_at >= $3",
      [employeeId, backlogId, since],
    );
    return { tasks: r.rows[0]!.tasks, costUsd: r.rows[0]!.cost };
  }

  /** The most recent finished tasks of the backlog since it was last resumed, newest first. */
  async lastFinishedByBacklog(employeeId: string, backlogId: string, n: number): Promise<{ id: string; status: TaskStatus }[]> {
    const r = await this.db.query<{ id: string; status: TaskStatus }>(
      `SELECT t.id, t.status FROM tasks t
        LEFT JOIN backlog_state s ON s.employee_id = t.employee_id AND s.backlog_id = $2
        WHERE t.employee_id = $1 AND t.source->>'backlogId' = $2 AND t.status IN ('done','failed','cancelled')
          AND t.updated_at > COALESCE(s.resumed_at, '-infinity'::timestamptz)
        ORDER BY t.updated_at DESC, t.id LIMIT $3`,
      [employeeId, backlogId, n],
    );
    return r.rows;
  }

  async getBacklogHalt(employeeId: string, backlogId: string): Promise<{ haltedAt: Date; reason: string } | undefined> {
    const r = await this.db.query<{ halted_at: Date | null; halted_reason: string | null }>("SELECT halted_at, halted_reason FROM backlog_state WHERE employee_id = $1 AND backlog_id = $2", [employeeId, backlogId]);
    const row = r.rows[0];
    return row?.halted_at ? { haltedAt: row.halted_at, reason: row.halted_reason ?? "" } : undefined;
  }

  /** True only on the call that halted it (so the alert goes out once). */
  async haltBacklog(employeeId: string, backlogId: string, reason: string): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO backlog_state (employee_id, backlog_id, halted_at, halted_reason) VALUES ($1,$2,now(),$3)
       ON CONFLICT (employee_id, backlog_id) DO UPDATE SET halted_at = now(), halted_reason = EXCLUDED.halted_reason WHERE backlog_state.halted_at IS NULL`,
      [employeeId, backlogId, reason],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** False if it was not halted. Failures before now no longer count toward the next halt. */
  async resumeBacklog(employeeId: string, backlogId: string): Promise<boolean> {
    const r = await this.db.query("UPDATE backlog_state SET halted_at = NULL, halted_reason = NULL, resumed_at = now() WHERE employee_id = $1 AND backlog_id = $2 AND halted_at IS NOT NULL", [employeeId, backlogId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** True the first time per `day` (so the budget alert goes out once a day). */
  async markBudgetAlerted(employeeId: string, backlogId: string, day: string): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO backlog_state (employee_id, backlog_id, alerted_budget_on) VALUES ($1,$2,$3)
       ON CONFLICT (employee_id, backlog_id) DO UPDATE SET alerted_budget_on = EXCLUDED.alerted_budget_on WHERE backlog_state.alerted_budget_on IS DISTINCT FROM EXCLUDED.alerted_budget_on`,
      [employeeId, backlogId, day],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---- manager wakes
  /** Called when a backlog task finishes. Coalesces: many completions before the next run = one wake. */
  async requestManagerWake(employeeId: string, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO manager_state (employee_id, wake_pending, wake_reason) VALUES ($1, true, $2)
       ON CONFLICT (employee_id) DO UPDATE SET wake_pending = true,
         wake_reason = CASE WHEN manager_state.wake_pending THEN manager_state.wake_reason || '; ' || $2 ELSE $2 END`,
      [employeeId, reason],
    );
  }

  /**
   * Claims a wake if one is due, atomically, and returns why. Two ways to be due: backlog work finished
   * (debounced), or nothing has run for `heartbeatMin` and we should look anyway — otherwise a stall,
   * where nothing finishes because nothing was dispatched, would never be noticed. `null` = nothing to do.
   */
  async claimManagerWake(employeeId: string, now: Date, debounceSec: number, heartbeatMin = 0): Promise<string | null> {
    const r = await this.db.query<{ wake_reason: string | null; was_pending: boolean }>(
      // $2 must be cast: untyped, Postgres infers it as `interval` from `$2 - (...)::interval` and the
      // comparison becomes `timestamptz <= interval`, which threw on every tick and meant the manager
      // could never wake. $4 arrives as text, so it needs a cast to compare against 0.
      // The old row is read in a CTE because UPDATE ... RETURNING yields the NEW values, so returning
      // wake_pending/wake_reason directly always reported false/NULL and every wake looked like a heartbeat.
      `WITH prev AS (
         SELECT employee_id, wake_pending, wake_reason, last_wake_at
           FROM manager_state WHERE employee_id = $1 FOR UPDATE
       ), upd AS (
         UPDATE manager_state m SET wake_pending = false, last_wake_at = $2::timestamptz, wake_reason = NULL
           FROM prev p
          WHERE m.employee_id = p.employee_id
            AND (
              (p.wake_pending AND (p.last_wake_at IS NULL OR p.last_wake_at <= $2::timestamptz - ($3 || ' seconds')::interval))
              OR ($4::int > 0 AND (p.last_wake_at IS NULL OR p.last_wake_at <= $2::timestamptz - ($4 || ' minutes')::interval))
            )
        RETURNING p.wake_reason AS wake_reason, p.wake_pending AS was_pending
       )
       SELECT wake_reason, was_pending FROM upd`,
      [employeeId, now, String(debounceSec), String(heartbeatMin)],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0]!;
    return row.wake_reason ?? (row.was_pending ? "backlog task finished" : "HEARTBEAT");
  }

  /** The manager only exists once a row does; the heartbeat needs somewhere to start from. */
  async ensureManagerState(employeeId: string): Promise<void> {
    await this.db.query("INSERT INTO manager_state (employee_id) VALUES ($1) ON CONFLICT DO NOTHING", [employeeId]);
  }

  // ---- monitors
  async getMonitor(employeeId: string, name: string): Promise<MonitorRow | undefined> {
    const r = await this.db.query<MonitorRow>("SELECT * FROM monitors WHERE employee_id = $1 AND name = $2", [employeeId, name]);
    return r.rows[0];
  }

  async listMonitors(employeeId: string): Promise<MonitorRow[]> {
    const r = await this.db.query<MonitorRow>("SELECT * FROM monitors WHERE employee_id = $1 ORDER BY name", [employeeId]);
    return r.rows;
  }

  async setMonitorEnabled(employeeId: string, name: string, enabled: boolean, byTask?: string): Promise<MonitorRow> {
    const r = await this.db.query<MonitorRow>(
      `INSERT INTO monitors (employee_id, name, enabled, updated_by_task) VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, name) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by_task = EXCLUDED.updated_by_task, updated_at = now()
       RETURNING *`,
      [employeeId, name, enabled, byTask ?? null],
    );
    return r.rows[0]!;
  }

  async saveMonitorRun(employeeId: string, name: string, state: unknown, ranAt: Date, fired: boolean): Promise<void> {
    await this.db.query(
      `UPDATE monitors SET state = $3, last_run_at = $4, last_fired_at = CASE WHEN $5 THEN $4 ELSE last_fired_at END, updated_at = now()
       WHERE employee_id = $1 AND name = $2`,
      [employeeId, name, JSON.stringify(state), ranAt, fired],
    );
  }

  // ---- stats
  /** Usage/cost rollup over [since, until). `employeeId` undefined = all employees. */
  async stats(employeeId: string | undefined, since: Date, until: Date): Promise<Stats> {
    const params = [employeeId ?? null, since, until];
    const bucket = (r: BucketRow): StatsBucket => ({
      tasks: Number(r.tasks),
      done: Number(r.done),
      failed: Number(r.failed),
      cancelled: Number(r.cancelled),
      costUsd: round4(Number(r.cost_usd)),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      numTurns: Number(r.num_turns),
    });

    const totalsR = await this.db.query<BucketRow>(`${STATS_CTE} SELECT ${BUCKET_SELECT} FROM scoped`, params);
    const byDayR = await this.db.query<BucketRow & { day: string }>(
      `${STATS_CTE} SELECT date_trunc('day', created_at) AS day, ${BUCKET_SELECT} FROM scoped GROUP BY 1 ORDER BY 1`,
      params,
    );
    const byRoleR = await this.db.query<BucketRow & { role: string }>(
      `${STATS_CTE} SELECT role_id AS role, ${BUCKET_SELECT} FROM scoped GROUP BY 1 ORDER BY 1`,
      params,
    );
    const byChannelR = await this.db.query<BucketRow & { channel: string }>(
      `${STATS_CTE} SELECT channel, ${BUCKET_SELECT} FROM scoped GROUP BY 1 ORDER BY 1`,
      params,
    );
    const topR = await this.db.query<{ id: string; role: string; channel: string; cost_usd: string | null; num_turns: string | null; status: string; prompt: string }>(
      `${STATS_CTE} SELECT id, role_id AS role, channel, cost_usd, num_turns, status, left(prompt, 80) AS prompt
       FROM scoped ORDER BY cost_usd DESC NULLS LAST LIMIT 10`,
      params,
    );

    return {
      since: since.toISOString(),
      until: until.toISOString(),
      totals: bucket(totalsR.rows[0]!),
      byDay: byDayR.rows.map((r) => ({ day: r.day, ...bucket(r) })),
      byRole: byRoleR.rows.map((r) => ({ role: r.role, ...bucket(r) })),
      byChannel: byChannelR.rows.map((r) => ({ channel: r.channel, ...bucket(r) })),
      topTasks: topR.rows.map((r) => ({
        id: r.id,
        role: r.role,
        channel: r.channel,
        costUsd: round4(Number(r.cost_usd ?? 0)),
        numTurns: Number(r.num_turns ?? 0),
        status: r.status,
        prompt: r.prompt,
      })),
    };
  }

  /** Non-null `result.text` for every task in the window; used to scan for PR links in the daily digest. */
  async resultTextsSince(employeeId: string, since: Date, until: Date): Promise<string[]> {
    const r = await this.db.query<{ text: string }>(
      `SELECT result->>'text' AS text FROM tasks
       WHERE employee_id = $1 AND created_at >= $2 AND created_at < $3 AND result->>'text' IS NOT NULL`,
      [employeeId, since, until],
    );
    return r.rows.map((x) => x.text);
  }
}

interface BucketRow {
  tasks: string;
  done: string;
  failed: string;
  cancelled: string;
  cost_usd: string | null;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  num_turns: string;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * `scoped`: every task in [since, until) (optionally filtered to one employee), with `channel`
 * substituted for the ROOT task's source channel — a workstream child's own source.channel is
 * "child", which is useless for grouping, so `root_id` (walked via a recursive CTE up parent_task_id)
 * lets a parent+children run roll up under the root's real origin channel.
 */
// ponytail: ancestry walks the whole tasks table (unfiltered by date) since parent_task_id has
// no created_at bound; fine at this scale, add a tasks(parent_task_id) time filter if it's ever slow.
const STATS_CTE = `
WITH RECURSIVE ancestry AS (
  SELECT id AS orig_id, id, parent_task_id FROM tasks
  UNION ALL
  SELECT a.orig_id, t.id, t.parent_task_id
  FROM ancestry a JOIN tasks t ON t.id = a.parent_task_id
),
roots AS (
  SELECT orig_id AS id, id AS root_id FROM ancestry WHERE parent_task_id IS NULL
),
scoped AS (
  SELECT
    t.id, t.role_id, t.status, t.created_at, t.prompt,
    rt.source->>'channel' AS channel,
    (t.result->>'costUsd')::numeric AS cost_usd,
    (t.result->>'inputTokens')::numeric AS input_tokens,
    (t.result->>'outputTokens')::numeric AS output_tokens,
    (t.result->>'cacheReadTokens')::numeric AS cache_read_tokens,
    (t.result->>'numTurns')::numeric AS num_turns
  FROM tasks t
  JOIN roots r ON r.id = t.id
  JOIN tasks rt ON rt.id = r.root_id
  WHERE t.created_at >= $2 AND t.created_at < $3
    AND ($1::text IS NULL OR t.employee_id = $1)
)`;

const BUCKET_SELECT = `
  count(*) AS tasks,
  count(*) FILTER (WHERE status = 'done') AS done,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(num_turns), 0) AS num_turns
`;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function randomBase62(len: number): string {
  return Array.from(randomBytes(len), (b) => BASE62[b % 62]).join("");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
