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
  | ExitEvent;

export const TERMINAL_EVENT_TYPES: ReadonlySet<RunnerEventType> = new Set<RunnerEventType>(["exit"]);
