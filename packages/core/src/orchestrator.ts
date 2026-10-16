/**
 * Orchestrator — the ONLY boundary between application code and the durable
 * execution engine (DBOS today; Temporal is one adapter file + one workflow body away).
 *
 * Rules for any workflow body written against this system, regardless of engine:
 *   - no Date.now(), Math.random(), IO, network, or env reads in the body
 *   - the body only sequences step calls and waits
 *   - steps are plain, engine-free functions
 * DBOS does not enforce these; we follow them so a Temporal port is a translation, not a debug.
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "done"
  | "failed"
  | "cancelled"
  | "unknown";

export interface TaskSource {
  channel: "slack" | "http" | "clickup" | "clickup-chat" | "telegram" | "cron" | "azure" | "github" | "child";
  conversationId?: string;
  /** Channel-native thread reference, e.g. Slack `channel:thread_ts`, ClickUp task id, ClickUp chat channel id, Telegram chat id. */
  threadRef?: string;
  /** Channel-native id of the message/comment that triggered the task (for reactions / acks). */
  messageRef?: string;
  /** Parent task id when spawned as a sub-agent. */
  parentTaskId?: string;
  /** Immediate parent's source.channel, when spawned as a sub-agent (channel is "child"). */
  originChannel?: string;
  /** Spawn depth: 0 for human-triggered, else parent depth + 1. */
  depth?: number;
  /** Machine-triggered (monitor): no placeholder, and a result of exactly "NOISE" is not posted. */
  quiet?: boolean;
  /**
   * Backlog work the manager dispatched. When a task carrying this reaches a terminal state the manager
   * is woken (debounced) to decide what happens next. The manager's OWN runs never carry it, or it would
   * wake itself forever.
   */
  managedBy?: string;
  /** Set on a child the manager spawned for a backlog item: it counts toward the backlog's limits and wakes the manager when it ends. */
  backlogId?: string;
  backlogItem?: string;
}

export interface TaskInput {
  employeeId: string;
  roleId: string;
  prompt: string;
  source: TaskSource;
}

export interface StartResult {
  /** false when a task with this id already existed (dedup hit). */
  started: boolean;
  status: TaskStatus;
}

export interface Orchestrator {
  /** `taskId` is the dedup key. Same id twice → second call returns started:false. */
  startTask(taskId: string, input: TaskInput): Promise<StartResult>;
  signal(taskId: string, name: string, payload: unknown): Promise<void>;
  cancel(taskId: string): Promise<void>;
  status(taskId: string): Promise<TaskStatus>;
  /** Idempotent by `name`. */
  schedule(name: string, cron: string, input: TaskInput): Promise<void>;
}
