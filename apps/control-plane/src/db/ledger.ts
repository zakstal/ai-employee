import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { RunHandle, RunnerEvent, TaskInput, TaskStatus } from "@ai-employee/core";

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
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO conversations (employee_id, channel, external_ref) VALUES ($1,$2,$3)
       ON CONFLICT (channel, external_ref) DO UPDATE SET external_ref = EXCLUDED.external_ref
       RETURNING id`,
      [employeeId, channel, externalRef],
    );
    return r.rows[0]!.id;
  }

  async getConversationSession(conversationId: string): Promise<string | null> {
    const r = await this.db.query<{ session_id: string | null }>("SELECT session_id FROM conversations WHERE id = $1", [conversationId]);
    return r.rows[0]?.session_id ?? null;
  }

  async setConversationSession(conversationId: string, sessionId: string): Promise<void> {
    await this.db.query("UPDATE conversations SET session_id = $2 WHERE id = $1", [conversationId, sessionId]);
  }

  /** Returns false if the task already existed (dedup). */
  async createTask(id: string, input: TaskInput): Promise<boolean> {
    const r = await this.db.query(
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
    );
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
