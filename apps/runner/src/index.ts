import { createInterface } from "node:readline";
import { LIMIT_RE, parseLimitMessage, type RunnerEvent } from "@ai-employee/core";
import { bootstrapTools } from "./bootstrap.js";
import { spawnClaudeCode } from "./harness/claude-code.js";
import { translateLine } from "./harness/parse.js";
import { MAX_LIMIT_RECOVERIES, RESUME_PROMPT, recoverFromLimit } from "./limits.js";
import { EventSink } from "./sink.js";
import { startServer } from "./server.js";

const SIGTERM_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const env = process.env;
  const runId = env.TASK_ID ?? "unknown";

  const eventSinkUrl = env.EVENT_SINK_URL;
  const runToken = env.RUN_TOKEN;
  if (!eventSinkUrl || !runToken) {
    console.error("[runner] missing EVENT_SINK_URL or RUN_TOKEN");
    process.exit(2);
    return;
  }

  let seq = 1;
  const nextSeq = () => seq++;
  const now = () => new Date().toISOString();
  const sink = new EventSink(eventSinkUrl, runToken);

  const taskPrompt = env.TASK_PROMPT;
  if (!taskPrompt) {
    sink.push({ runId, seq: nextSeq(), ts: now(), type: "error", message: "TASK_PROMPT is required" });
    await sink.close();
    process.exit(2);
    return;
  }

  for (const note of bootstrapTools(env)) process.stderr.write(`[runner] ${note}\n`);

  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    sink.push({ runId, seq: nextSeq(), ts: now(), type: "exit", code });
    void sink.close().then(() => process.exit(code));
  };

  // Usage limits: the CLI ends with a lone "You've hit your session limit · resets 5:40pm (UTC)" result. That result is
  // withheld (the control plane would take it as the task's answer); the account is switched or waited out, then the
  // SAME session is resumed. `sessionId` follows the latest `started` event.
  let sessionId = env.RESUME_SESSION_ID || undefined;
  let recoveries = 0;
  let limitResult: Extract<RunnerEvent, { type: "result" }> | undefined;
  let waiting = false;
  const timeoutSec = Number(env.TASK_TIMEOUT_SEC);
  const deadlineMs = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Number.POSITIVE_INFINITY;
  const recover = async (hit: NonNullable<ReturnType<typeof parseLimitMessage>>): Promise<boolean> => {
    waiting = true;
    try {
      return (
        (await recoverFromLimit(
          {
            env,
            fetch,
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            deadlineMs,
            reportLimit: (ev) => sink.push({ runId, seq: nextSeq(), ts: now(), type: "limit_hit", ...ev }),
            heartbeat: (note) => sink.push({ runId, seq: nextSeq(), ts: now(), type: "heartbeat", note }),
            log: (line) => process.stderr.write(`[runner] ${line}\n`),
          },
          hit,
        )) === "resume"
      );
    } finally {
      waiting = false;
    }
  };

  let current: ReturnType<typeof spawnClaudeCode> | undefined;
  const launch = (resumeSessionId: string | undefined, prompt: string = taskPrompt): void => {
    let resumeFailed = false;
    // A missing session exits 0 with a lone `result` (is_error, num_turns 0) and "No conversation found" on
    // stderr. Hold events back until the resumed session proves alive (any tool_use/assistant_text), so a
    // failed resume can be discarded and retried fresh without the control plane seeing the bogus result.
    let held: RunnerEvent[] | null = resumeSessionId ? [] : null;
    const release = (): void => {
      if (held) for (const ev of held) sink.push(ev);
      held = null;
    };
    const child = spawnClaudeCode({
      prompt,
      maxTurns: Number(env.MAX_TURNS),
      systemPrompt: env.SYSTEM_PROMPT,
      allowedTools: env.ALLOWED_TOOLS,
      disallowedTools: env.DISALLOWED_TOOLS,
      mcpConfig: env.MCP_CONFIG,
      model: env.MODEL,
      claudeBin: env.CLAUDE_BIN ?? "claude",
      workspaceDir: env.WORKSPACE_DIR ?? "/workspace",
      resumeSessionId,
      // A session file that is gone (volume wiped, other host) must not fail the task: fall back to a fresh session.
      onStderrLine: (line) => {
        if (resumeSessionId && /no conversation found|session.*not found|could not resume/i.test(line)) resumeFailed = true;
      },
    });
    current = child;

    const stdoutLines = createInterface({ input: child.stdout! });
    stdoutLines.on("line", (line) => {
      const events: RunnerEvent[] = translateLine(line, { runId, nextSeq, now }).filter((ev) => {
        if (ev.type === "started") {
          if (ev.sessionId) sessionId = ev.sessionId;
          if (env.CLAUDE_ACCOUNT) ev.account = env.CLAUDE_ACCOUNT;
        }
        if (ev.type === "result" && ev.text.length < 500 && LIMIT_RE.test(ev.text)) {
          limitResult = ev;
          return false;
        }
        return true;
      });
      if (held) {
        held.push(...events);
        if (events.some((e) => e.type === "tool_use" || e.type === "assistant_text")) release();
        return;
      }
      for (const ev of events) sink.push(ev);
    });

    child.on("error", (err) => {
      sink.push({ runId, seq: nextSeq(), ts: now(), type: "error", message: err.message });
      finish(127);
    });

    child.on("exit", (code, signal) => {
      if (limitResult && !finished) {
        const lr = limitResult;
        limitResult = undefined;
        release();
        if (code !== 0 || lr.isError) {
          const hit = parseLimitMessage(lr.text);
          if (hit && recoveries < MAX_LIMIT_RECOVERIES) {
            recoveries++;
            void recover(hit).then((resume) => {
              if (resume && !finished) {
                launch(sessionId, sessionId ? RESUME_PROMPT : `${taskPrompt}\n\n${RESUME_PROMPT}`);
              } else {
                sink.push(lr);
                finish(code ?? 1);
              }
            });
            return;
          }
        }
        sink.push(lr); // not a recoverable limit (cap reached, or a clean answer that quotes one): report it as the result
        finish(code !== null ? code : signal ? 137 : 1);
        return;
      }
      if (held && !finished) {
        const deadOnArrival = held.every((e) => e.type !== "result" || (e.isError && (e.numTurns ?? 0) === 0));
        if (resumeFailed || deadOnArrival) {
          process.stderr.write(`[runner] resume of session ${resumeSessionId} failed (exit ${code}); starting a fresh session\n`);
          held = null;
          launch(undefined);
          return;
        }
        release();
      }
      finish(code !== null ? code : signal ? 137 : 1);
    });
  };
  launch(env.RESUME_SESSION_ID || undefined);

  process.on("SIGTERM", () => {
    if (waiting) return finish(143); // sleeping through a limit: no child to stop
    current?.kill("SIGINT");
    setTimeout(() => {
      if (!finished) current?.kill("SIGKILL");
    }, SIGTERM_GRACE_MS).unref();
  });
}

if (process.env.RUNNER_MODE === "server") {
  startServer();
} else {
  main();
}
