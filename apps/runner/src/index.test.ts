import { execSync, spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const distIndex = path.join(pkgRoot, "dist", "index.js");
const fakeClaude = path.join(pkgRoot, "test", "fake-claude.sh");

beforeAll(() => {
  execSync("tsc -b tsconfig.json", { cwd: pkgRoot, stdio: "inherit" });
}, 60_000);

interface SinkEvent {
  type: string;
  seq: number;
  sessionId?: string;
  isError?: boolean;
}

/** Runs dist/index.js against the fake claude with a local event sink; returns exit code + everything the sink got. */
async function runRunner(extraEnv: Record<string, string>): Promise<{ exitCode: number; events: SinkEvent[]; authOk: boolean }> {
  const requests: { authorization?: string | undefined; events: SinkEvent[] }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { events: SinkEvent[] };
      requests.push({ authorization: req.headers.authorization, events: parsed.events });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-"));

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [distIndex], {
      env: {
        ...process.env,
        TASK_ID: "task-1",
        TASK_PROMPT: "do a thing",
        SYSTEM_PROMPT: "",
        ALLOWED_TOOLS: "",
        DISALLOWED_TOOLS: "",
        MAX_TURNS: "5",
        MCP_CONFIG: "{}",
        EVENT_SINK_URL: `http://127.0.0.1:${address.port}/events`,
        RUN_TOKEN: "test-run-token",
        CLAUDE_BIN: fakeClaude,
        WORKSPACE_DIR: workspaceDir,
        ...extraEnv,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? -1));
  });
  server.close();
  return { exitCode, events: requests.flatMap((r) => r.events), authOk: requests.every((r) => r.authorization === "Bearer test-run-token") };
}

const NORMAL_SEQUENCE = ["started", "assistant_text", "tool_use", "tool_result", "result", "exit"];

describe("runner end-to-end", () => {
  it("streams normalized events to the sink in order and exits 0", async () => {
    const { exitCode, events, authOk } = await runRunner({});
    expect(exitCode).toBe(0);
    expect(events.map((e) => e.type)).toEqual(NORMAL_SEQUENCE);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(authOk).toBe(true);
  }, 30_000);

  it("passes RESUME_SESSION_ID as --resume and streams the resumed session", async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runner-args-")), "args.log");
    const { exitCode, events } = await runRunner({ RESUME_SESSION_ID: "sess-old", FAKE_ARGS_LOG: log });
    expect(exitCode).toBe(0);
    expect(events.map((e) => e.type)).toEqual(NORMAL_SEQUENCE);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--resume sess-old");
  }, 30_000);

  it("falls back to a fresh session when the resumed one is gone, without leaking the dead result", async () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "runner-args-")), "args.log");
    const { exitCode, events } = await runRunner({ RESUME_SESSION_ID: "sess-old", FAKE_DEAD_RESUME: "1", FAKE_ARGS_LOG: log });
    expect(exitCode).toBe(0);
    // the is_error/num_turns 0 result from the dead resume never reaches the sink
    expect(events.map((e) => e.type)).toEqual(NORMAL_SEQUENCE);
    expect(events.find((e) => e.type === "started")?.sessionId).toBe("sess-123");
    expect(events.filter((e) => e.type === "result").every((e) => !e.isError)).toBe(true);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--resume sess-old");
    expect(calls[1]).not.toContain("--resume");
  }, 30_000);
});
