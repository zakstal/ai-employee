/**
 * Normalized runner events. The runner translates harness-native output
 * (Claude Code stream-json, Gemini CLI, ACP) into these before pushing them to
 * the control plane event sink. Nothing downstream knows which harness ran.
 */
export type RunnerEventType =
  | "started"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "limit_hit"
  | "heartbeat"
  | "exit";

export interface RunnerEventBase {
  runId: string;
  /** Monotonic per run; the sink dedups on (runId, seq). */
  seq: number;
  /** ISO-8601, set by the runner. */
  ts: string;
  type: RunnerEventType;
}

export interface StartedEvent extends RunnerEventBase {
  type: "started";
  harness: string;
  model?: string;
  sessionId?: string;
  /** Claude subscription account (name only, never the token) this run authenticates with. */
  account?: string;
}
export interface AssistantTextEvent extends RunnerEventBase {
  type: "assistant_text";
  text: string;
}
export interface ToolUseEvent extends RunnerEventBase {
  type: "tool_use";
  tool: string;
  input: unknown;
}
export interface ToolResultEvent extends RunnerEventBase {
  type: "tool_result";
  tool?: string;
  output: unknown;
  isError?: boolean;
}
export interface ResultEvent extends RunnerEventBase {
  type: "result";
  text: string;
  isError: boolean;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
export interface ErrorEvent extends RunnerEventBase {
  type: "error";
  message: string;
}
/** The Claude subscription hit its usage limit mid-run. `action` is what the control plane told the runner to do about it. */
export interface LimitHitEvent extends RunnerEventBase {
  type: "limit_hit";
  account?: string;
  /** ISO-8601 reset time parsed from the limit message. */
  resetsAt?: string;
  action: "failover" | "wait" | "exit";
  /** failover: the account the run continues on. */
  toAccount?: string;
  /** wait: ISO-8601 time the runner resumes. */
  waitUntil?: string;
}
/** Sent every couple of minutes while the runner sleeps through a limit wait, so a quiet task is visibly alive. */
export interface HeartbeatEvent extends RunnerEventBase {
  type: "heartbeat";
  note?: string;
}
export interface ExitEvent extends RunnerEventBase {
  type: "exit";
  code: number;
}

export type RunnerEvent =
  | StartedEvent
  | AssistantTextEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
  | LimitHitEvent
  | HeartbeatEvent
  | ExitEvent;

export const TERMINAL_EVENT_TYPES: ReadonlySet<RunnerEventType> = new Set<RunnerEventType>(["exit"]);
