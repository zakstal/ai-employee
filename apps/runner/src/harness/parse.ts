import type { RunnerEvent } from "@ai-employee/core";

export interface TranslateCtx {
  runId: string;
  nextSeq: () => number;
  now: () => string;
}

/**
 * Maps one line of Claude Code `stream-json` output to zero or more
 * normalized RunnerEvents. Never throws: a non-JSON or unrecognized line
 * yields []. Exact `subtype` enum on "result" beyond "success" is
 * unverified upstream, so anything else is treated as an error result.
 */
export function translateLine(line: string, ctx: TranslateCtx): RunnerEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- boundary parse of an external, loosely-documented wire format
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const base = () => ({ runId: ctx.runId, seq: ctx.nextSeq(), ts: ctx.now() });

  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return [];
      return [
        {
          ...base(),
          type: "started",
          harness: "claude-code",
          ...(typeof msg.model === "string" ? { model: msg.model } : {}),
          ...(typeof msg.session_id === "string" ? { sessionId: msg.session_id } : {}),
        },
      ];
    }

    case "assistant": {
      const content: unknown[] = msg.message?.content ?? [];
      const events: RunnerEvent[] = [];
      for (const block of content) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b = block as any;
        if (b.type === "text") {
          events.push({ ...base(), type: "assistant_text", text: b.text });
        } else if (b.type === "tool_use") {
          events.push({ ...base(), type: "tool_use", tool: b.name, input: b.input });
        }
      }
      return events;
    }

    case "user": {
      const content: unknown[] = msg.message?.content ?? [];
      const events: RunnerEvent[] = [];
      for (const block of content) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b = block as any;
        if (b.type === "tool_result") {
          events.push({
            ...base(),
            type: "tool_result",
            output: b.content,
            ...(typeof b.is_error === "boolean" ? { isError: b.is_error } : {}),
          });
        }
      }
      return events;
    }

    case "result": {
      return [
        {
          ...base(),
          type: "result",
          text: msg.result ?? "",
          isError: msg.is_error === true || msg.subtype !== "success",
          ...(typeof msg.total_cost_usd === "number" ? { costUsd: msg.total_cost_usd } : {}),
          ...(typeof msg.duration_ms === "number" ? { durationMs: msg.duration_ms } : {}),
          ...(typeof msg.num_turns === "number" ? { numTurns: msg.num_turns } : {}),
          ...usageFields(msg.usage),
        },
      ];
    }

    case "stream_event":
    default:
      return [];
  }
}

/** Token usage from Claude Code's final `result` line (`usage` block), when present. */
function usageFields(usage: unknown): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const out: Record<string, number> = {};
  const i = num(u.input_tokens), o = num(u.output_tokens), cr = num(u.cache_read_input_tokens), cc = num(u.cache_creation_input_tokens);
  if (i !== undefined) out.inputTokens = i;
  if (o !== undefined) out.outputTokens = o;
  if (cr !== undefined) out.cacheReadTokens = cr;
  if (cc !== undefined) out.cacheCreationTokens = cc;
  return out;
}
