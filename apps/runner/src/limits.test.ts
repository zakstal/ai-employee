import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_MS, WAIT_SLACK_MS, recoverFromLimit, runTokenRefreshHooks, type RecoveryDeps } from "./limits.js";

const T0 = Date.parse("2026-10-16T12:00:00Z");
const HIT = { window: "5h" as const, resetsAt: new Date("2026-10-16T17:40:00Z") };

function setup(reply: unknown, over: Partial<RecoveryDeps> = {}, status = 200) {
  let t = T0;
  const calls: { url: string; init: RequestInit }[] = [];
  const events: unknown[] = [];
  const beats: string[] = [];
  const logs: string[] = [];
  const hooks: { token: string; account: string | undefined }[] = [];
  const env: NodeJS.ProcessEnv = { CONTROL_PLANE_URL: "http://cp", RUN_TOKEN: "run-tok", TASK_ID: "task-1", CLAUDE_ACCOUNT: "work", CLAUDE_CODE_OAUTH_TOKEN: "old-token" };
  const deps: RecoveryDeps = {
    env,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), { status });
    }) as unknown as typeof fetch,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    deadlineMs: Number.POSITIVE_INFINITY,
    reportLimit: (ev) => events.push(ev),
    heartbeat: (n) => beats.push(n),
    log: (l) => logs.push(l),
    runHooks: (token, account) => (hooks.push({ token, account }), []),
    ...over,
  };
  return { deps, env, calls, events, beats, logs, hooks, now: () => t };
}

describe("recoverFromLimit", () => {
  it("asks the control plane with the run token, account, reset time and window", async () => {
    const s = setup({ action: "exit", reason: "x" });
    await recoverFromLimit(s.deps, HIT);
    expect(s.calls[0]!.url).toBe("http://cp/agents/self/limit");
    const h = s.calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer run-tok");
    expect(h["x-task-id"]).toBe("task-1");
    expect(JSON.parse(s.calls[0]!.init.body as string)).toEqual({ account: "work", resetsAt: "2026-10-16T17:40:00.000Z", window: "5h" });
  });

  it("failover: adopts the new token and account in env, runs hooks with it, reports, resumes at once", async () => {
    const s = setup({ action: "failover", account: "personal", token: "new-token" });
    expect(await recoverFromLimit(s.deps, HIT)).toBe("resume");
    expect(s.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "new-token", CLAUDE_ACCOUNT: "personal" });
    expect(s.hooks).toEqual([{ token: "new-token", account: "personal" }]);
    expect(s.events).toEqual([{ account: "work", resetsAt: "2026-10-16T17:40:00.000Z", action: "failover", toAccount: "personal" }]);
    expect(s.now()).toBe(T0); // no sleeping
    expect(JSON.stringify([s.events, s.logs])).not.toContain("new-token");
  });

  it("wait: sleeps until waitUntil + 60s with heartbeats, then resumes on the same token (no hooks)", async () => {
    const waitUntil = new Date(T0 + 10 * 60_000).toISOString();
    const s = setup({ action: "wait", waitUntil });
    expect(await recoverFromLimit(s.deps, HIT)).toBe("resume");
    expect(s.now()).toBe(T0 + 10 * 60_000 + WAIT_SLACK_MS);
    expect(s.beats.length).toBeGreaterThanOrEqual(Math.floor((10 * 60_000 + WAIT_SLACK_MS) / HEARTBEAT_MS));
    expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-token");
    expect(s.hooks).toEqual([]);
    expect(s.events[0]).toMatchObject({ action: "wait", waitUntil });
  });

  it("wait that names another account: switches to it after waking", async () => {
    const s = setup({ action: "wait", waitUntil: new Date(T0 + 60_000).toISOString(), account: "personal", token: "p-token" });
    expect(await recoverFromLimit(s.deps, HIT)).toBe("resume");
    expect(s.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "p-token", CLAUDE_ACCOUNT: "personal" });
    expect(s.hooks).toEqual([{ token: "p-token", account: "personal" }]);
  });

  it("wait that would outlast the task's time limit: reports and exits without sleeping", async () => {
    const waitUntil = new Date(T0 + 2 * 3600_000).toISOString();
    const s = setup({ action: "wait", waitUntil }, { deadlineMs: T0 + 3600_000 });
    expect(await recoverFromLimit(s.deps, HIT)).toBe("exit");
    expect(s.now()).toBe(T0);
    expect(s.events[0]).toMatchObject({ action: "exit", waitUntil });
  });

  it("a wait that just fits (including the 60s slack) resumes; one second over does not", async () => {
    const waitUntil = new Date(T0 + 600_000).toISOString();
    expect(await recoverFromLimit(setup({ action: "wait", waitUntil }, { deadlineMs: T0 + 600_000 + WAIT_SLACK_MS + 1 }).deps, HIT)).toBe("resume");
    expect(await recoverFromLimit(setup({ action: "wait", waitUntil }, { deadlineMs: T0 + 600_000 + WAIT_SLACK_MS }).deps, HIT)).toBe("exit");
  });

  it("exit decision (policy off, nothing to fail over to): reports and exits, env untouched", async () => {
    const s = setup({ action: "exit", reason: 'limitPolicy is "off"' });
    expect(await recoverFromLimit(s.deps, HIT)).toBe("exit");
    expect(s.events[0]).toMatchObject({ action: "exit" });
    expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("old-token");
  });

  it("control plane error, bad reply, or missing env: exits rather than guessing", async () => {
    expect(await recoverFromLimit(setup({ error: "boom" }, {}, 500).deps, HIT)).toBe("exit");
    expect(await recoverFromLimit(setup({ action: "dance" }).deps, HIT)).toBe("exit");
    const noEnv = setup({ action: "exit", reason: "x" });
    delete noEnv.env.RUN_TOKEN;
    expect(await recoverFromLimit(noEnv.deps, HIT)).toBe("exit");
    expect(noEnv.calls).toHaveLength(0);
    const down = setup({}, { fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(await recoverFromLimit(down.deps, HIT)).toBe("exit");
  });

  it("omits account/resetsAt it does not know", async () => {
    const s = setup({ action: "exit", reason: "x" });
    delete s.env.CLAUDE_ACCOUNT;
    await recoverFromLimit(s.deps, { window: "7d" });
    expect(JSON.parse(s.calls[0]!.init.body as string)).toEqual({ window: "7d" });
  });
});

describe("runTokenRefreshHooks", () => {
  function hookDir(files: Record<string, { body: string; mode: number }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-refresh-"));
    for (const [name, f] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), f.body, { mode: f.mode });
    return dir;
  }

  it("runs each executable in name order with the new token in CLAUDE_CODE_OAUTH_TOKEN, and skips non-executables", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "token-out-"));
    const dir = hookDir({
      "20-second.sh": { body: `#!/bin/sh\necho "second $CLAUDE_ACCOUNT" >> ${out}/log\necho done-second\n`, mode: 0o755 },
      "10-first.sh": { body: `#!/bin/sh\necho "first $CLAUDE_CODE_OAUTH_TOKEN" >> ${out}/log\nprintf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN" > ${out}/claude.env\n`, mode: 0o755 },
      "30-not-exec.sh": { body: `#!/bin/sh\necho nope >> ${out}/log\n`, mode: 0o644 },
    });
    const notes = runTokenRefreshHooks({ TOKEN_REFRESH_D_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "old" }, "new-token", "personal");
    expect(fs.readFileSync(path.join(out, "log"), "utf8")).toBe("first new-token\nsecond personal\n");
    expect(fs.readFileSync(path.join(out, "claude.env"), "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=new-token\n");
    expect(notes).toEqual(["token-refresh.d/10-first.sh: ok", "token-refresh.d/20-second.sh: done-second"]);
  });

  it("a failing hook is reported (token redacted) and does not stop the rest", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "token-out-"));
    const dir = hookDir({
      "10-bad.sh": { body: `#!/bin/sh\necho "cannot use $CLAUDE_CODE_OAUTH_TOKEN" >&2\nexit 3\n`, mode: 0o755 },
      "20-good.sh": { body: `#!/bin/sh\ntouch ${out}/ran\n`, mode: 0o755 },
    });
    const notes = runTokenRefreshHooks({ TOKEN_REFRESH_D_DIR: dir }, "sekrit-token", undefined);
    expect(fs.existsSync(path.join(out, "ran"))).toBe(true);
    expect(notes[0]).toBe("token-refresh.d/10-bad.sh: failed: cannot use ***");
    expect(notes.join("\n")).not.toContain("sekrit-token");
  });

  it("no hook directory is fine", () => {
    expect(runTokenRefreshHooks({ TOKEN_REFRESH_D_DIR: "/nonexistent/dir" }, "t", undefined)).toEqual([]);
  });
});
