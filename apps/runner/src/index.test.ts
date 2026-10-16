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
  text?: string;
  action?: string;
  account?: string;
  toAccount?: string;
}

/** Runs dist/index.js against the fake claude with a local event sink; returns exit code + everything the sink got. */
async function runRunner(
  extraEnv: Record<string, string>,
  limitReply?: unknown,
): Promise<{ exitCode: number; events: SinkEvent[]; authOk: boolean; limitRequests: { authorization?: string | undefined; taskId?: string | undefined; body: unknown }[] }> {
  const requests: { authorization?: string | undefined; events: SinkEvent[] }[] = [];
  const limitRequests: { authorization?: string | undefined; taskId?: string | undefined; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/agents/self/limit") {
        limitRequests.push({ authorization: req.headers.authorization, taskId: req.headers["x-task-id"] as string | undefined, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(limitReply ?? { action: "exit", reason: "none" }));
        return;
      }
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
        CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
        TOKEN_REFRESH_D_DIR: "/nonexistent",
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
  return { exitCode, events: requests.flatMap((r) => r.events), authOk: requests.every((r) => r.authorization === "Bearer test-run-token"), limitRequests };
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

  describe("Claude usage limit", () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runner-limit-"));

    it("failover: withholds the limit result, switches the token, runs token-refresh.d, resumes the SAME session and finishes", async () => {
      const dir = tmp();
      const hooks = tmp();
      fs.writeFileSync(path.join(hooks, "10-refresh.sh"), `#!/bin/sh
printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > ${dir}/refreshed
`, { mode: 0o755 });
      const argsLog = path.join(dir, "args.log");
      const envLog = path.join(dir, "env.log");
      const { exitCode, events, limitRequests } = await runRunner(
        { FAKE_LIMIT_TIMES: "1", FAKE_COUNT_FILE: path.join(dir, "count"), FAKE_ARGS_LOG: argsLog, FAKE_ENV_LOG: envLog, CLAUDE_CODE_OAUTH_TOKEN: "tok-work", CLAUDE_ACCOUNT: "work", TOKEN_REFRESH_D_DIR: hooks },
        { action: "failover", account: "personal", token: "tok-personal" },
      );
      expect(exitCode).toBe(0);
      expect(limitRequests).toHaveLength(1);
      expect(limitRequests[0]).toMatchObject({ authorization: "Bearer test-run-token", taskId: "task-1", body: { account: "work", window: "5h" } });
      expect((limitRequests[0]!.body as { resetsAt: string }).resetsAt).toMatch(/T17:40:00\.000Z$/);
      // the limit text never became the task's result; the second turn's did
      const results = events.filter((e) => e.type === "result");
      expect(results.map((e) => e.text)).toEqual(["Done"]);
      expect(events.find((e) => e.type === "limit_hit")).toMatchObject({ action: "failover", account: "work", toAccount: "personal" });
      expect(events.filter((e) => e.type === "started").map((e) => e.account)).toEqual(["work", "personal"]);
      expect(events.at(-1)?.type).toBe("exit");
      const seqs = events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      // second invocation: resumes sess-123 with the continue prompt, under the new token
      const calls = fs.readFileSync(argsLog, "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain("--resume");
      expect(calls[1]).toContain("--resume sess-123");
      expect(calls[1]).toContain("You hit a usage limit");
      expect(calls[1]).toContain("must be rerun");
      expect(fs.readFileSync(envLog, "utf8")).toBe("tok-work\ntok-personal\n");
      expect(fs.readFileSync(path.join(dir, "refreshed"), "utf8")).toBe("tok-personal");
    }, 30_000);

    it("wait that would outlast the task's time limit: not slept through; the limit result is reported and the task ends", async () => {
      // (the sleep-then-resume path is covered with a fake clock in limits.test.ts; the real 60s slack is too slow for e2e)
      const dir = tmp();
      const { exitCode, events } = await runRunner(
        { FAKE_LIMIT_TIMES: "1", FAKE_COUNT_FILE: path.join(dir, "count"), TASK_TIMEOUT_SEC: "5" },
        { action: "wait", waitUntil: new Date(Date.now() + 3000).toISOString() },
      );
      // 3s + 60s slack > 5s task time: reported and ended, not slept through
      expect(exitCode).toBe(1);
      expect(events.find((e) => e.type === "limit_hit")).toMatchObject({ action: "exit" });
      const result = events.find((e) => e.type === "result");
      expect(result?.text).toContain("hit your session limit"); // the original result is reported when recovery ends the task
      expect(events.at(-1)).toMatchObject({ type: "exit" });
    }, 30_000);

    it("off / exit decision: the task ends as before, with the limit message as its result and exit 1", async () => {
      const dir = tmp();
      const { exitCode, events, limitRequests } = await runRunner({ FAKE_LIMIT_TIMES: "9", FAKE_COUNT_FILE: path.join(dir, "count") }, { action: "exit", reason: 'limitPolicy is "off"' });
      expect(exitCode).toBe(1);
      expect(limitRequests).toHaveLength(1);
      expect(events.filter((e) => e.type === "result").map((e) => e.text)).toEqual(["You've hit your session limit · resets 5:40pm (UTC)"]);
      expect(events.find((e) => e.type === "limit_hit")).toMatchObject({ action: "exit" });
    }, 30_000);

    it("cap: after 3 recoveries the 4th limit ends the task without asking again", async () => {
      const dir = tmp();
      const argsLog = path.join(dir, "args.log");
      const { exitCode, events, limitRequests } = await runRunner(
        { FAKE_LIMIT_TIMES: "9", FAKE_COUNT_FILE: path.join(dir, "count"), FAKE_ARGS_LOG: argsLog },
        { action: "failover", account: "personal", token: "tok-personal" },
      );
      expect(exitCode).toBe(1);
      expect(limitRequests).toHaveLength(3);
      expect(fs.readFileSync(argsLog, "utf8").trim().split("\n")).toHaveLength(4);
      expect(events.filter((e) => e.type === "limit_hit")).toHaveLength(3);
      expect(events.filter((e) => e.type === "result")).toHaveLength(1); // only the last limit result is reported
      expect(events.find((e) => e.type === "result")?.text).toContain("hit your session limit");
    }, 30_000);

    it("no limit hit: the normal event sequence is untouched and the control plane is never asked", async () => {
      const { exitCode, events, limitRequests } = await runRunner({ FAKE_LIMIT_TIMES: "0", FAKE_COUNT_FILE: path.join(tmp(), "c") });
      expect(exitCode).toBe(0);
      expect(limitRequests).toHaveLength(0);
      expect(events.map((e) => e.type)).toEqual(NORMAL_SEQUENCE);
    }, 30_000);
  });
});
