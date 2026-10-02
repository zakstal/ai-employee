import { describe, expect, it } from "vitest";
import { translateLine, type TranslateCtx } from "./parse.js";

function ctx(): TranslateCtx {
  let seq = 1;
  return { runId: "run-1", nextSeq: () => seq++, now: () => "2026-01-01T00:00:00.000Z" };
}

describe("translateLine", () => {
  it("maps system/init to started", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4", session_id: "sess-1" });
    expect(translateLine(line, ctx())).toEqual([
      { runId: "run-1", seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "started", harness: "claude-code", model: "claude-opus-4", sessionId: "sess-1" },
    ]);
  });

  it("ignores non-init system lines", () => {
    const line = JSON.stringify({ type: "system", subtype: "other" });
    expect(translateLine(line, ctx())).toEqual([]);
  });

  it("maps assistant text and tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    expect(translateLine(line, ctx())).toEqual([
      { runId: "run-1", seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "assistant_text", text: "hi" },
      { runId: "run-1", seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "tool_use", tool: "Bash", input: { command: "ls" } },
    ]);
  });

  it("maps user tool_result blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "file1\nfile2", is_error: false }] },
    });
    expect(translateLine(line, ctx())).toEqual([
      { runId: "run-1", seq: 1, ts: "2026-01-01T00:00:00.000Z", type: "tool_result", output: "file1\nfile2", isError: false },
    ]);
  });

  it("maps a successful result", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.01,
      duration_ms: 1234,
      num_turns: 2,
    });
    expect(translateLine(line, ctx())).toEqual([
      {
        runId: "run-1",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        type: "result",
        text: "done",
        isError: false,
        costUsd: 0.01,
        durationMs: 1234,
        numTurns: 2,
      },
    ]);
  });

  it("treats a non-success result subtype as an error", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_max_turns", result: "gave up" });
    const [ev] = translateLine(line, ctx());
    expect(ev).toMatchObject({ type: "result", text: "gave up", isError: true });
  });

  it("skips stream_event lines", () => {
    const line = JSON.stringify({ type: "stream_event", event: {} });
    expect(translateLine(line, ctx())).toEqual([]);
  });

  it("skips unknown types", () => {
    const line = JSON.stringify({ type: "something_new" });
    expect(translateLine(line, ctx())).toEqual([]);
  });

  it("returns [] for a non-JSON line without throwing", () => {
    expect(translateLine("not json at all {{{", ctx())).toEqual([]);
  });

  it("returns [] for a blank line", () => {
    expect(translateLine("   ", ctx())).toEqual([]);
  });
});

describe("result usage", () => {
  it("maps token usage from the result line", async () => {
    const { translateLine } = await import("./parse.js");
    let n = 0;
    const ev = translateLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } }), { runId: "r", nextSeq: () => ++n, now: () => "t" });
    expect(ev[0]).toMatchObject({ type: "result", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheCreationTokens: 0 });
  });
});
