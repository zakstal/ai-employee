import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle, type ServerOptions } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeTask = path.join(here, "..", "test", "fake-task.js");
const TOKEN = "test-token";

let active: ServerHandle | undefined;

afterEach(async () => {
  if (active) {
    await new Promise<void>((resolve) => active!.server.close(() => resolve()));
    active = undefined;
  }
});

function start(overrides: Partial<ServerOptions> = {}): Promise<{ handle: ServerHandle; baseUrl: string; workspaceDir: string }> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "warm-runner-"));
  const opts: ServerOptions = {
    token: TOKEN,
    maxConcurrency: 4,
    workspaceDir,
    childScript: fakeTask,
    ...overrides,
  };
  const handle = createServer(opts);
  active = handle;
  return new Promise((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const addr = handle.server.address();
      if (addr === null || typeof addr === "string") throw new Error("expected TCP address");
      resolve({ handle, baseUrl: `http://127.0.0.1:${addr.port}`, workspaceDir });
    });
  });
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface RunBody {
  runId: string;
  status: string;
  code?: number;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
}

function post(baseUrl: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(baseUrl: string, runId: string, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } });
}

function del(baseUrl: string, runId: string, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/runs/${runId}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
}

function listRuns(baseUrl: string, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}/runs`, { headers: { authorization: `Bearer ${token}` } });
}

describe("runner server", () => {
  it("401s without a valid bearer token", async () => {
    const { baseUrl } = await start();
    const res = await post(baseUrl, { runId: "a", env: {}, timeoutSec: 5 }, "wrong");
    expect(res.status).toBe(401);
  });

  it("runs a task to completion: queued -> running -> exited", async () => {
    const { baseUrl } = await start();
    const created = await post(baseUrl, { runId: "run-1", env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "50" }, timeoutSec: 30 });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as RunBody;
    expect(["queued", "running"]).toContain(createdBody.status);

    const exited = await waitFor(
      () => get(baseUrl, "run-1").then((r) => r.json() as Promise<RunBody>),
      (b) => b.status === "exited",
    );
    expect(exited.code).toBe(0);
  });

  it("is idempotent on runId", async () => {
    const { baseUrl } = await start();
    const first = await post(baseUrl, { runId: "run-2", env: { FAKE_SLEEP_MS: "100" }, timeoutSec: 30 });
    expect(first.status).toBe(202);
    const second = await post(baseUrl, { runId: "run-2", env: { FAKE_SLEEP_MS: "100" }, timeoutSec: 30 });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as RunBody;
    expect(secondBody.runId).toBe("run-2");
  });

  it("queues beyond max concurrency and starts the next run after the first exits", async () => {
    const { baseUrl } = await start({ maxConcurrency: 1 });
    await post(baseUrl, { runId: "run-a", env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "300" }, timeoutSec: 30 });
    const b = await post(baseUrl, { runId: "run-b", env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "10" }, timeoutSec: 30 });
    const bBody = (await b.json()) as RunBody;
    expect(bBody.status).toBe("queued");

    const bExited = await waitFor(
      () => get(baseUrl, "run-b").then((r) => r.json() as Promise<RunBody>),
      (v) => v.status === "exited",
    );
    expect(bExited.code).toBe(0);
    const aExited = (await get(baseUrl, "run-a").then((r) => r.json())) as RunBody;
    expect(aExited.status).toBe("exited");
  });

  it("cancels a running run via DELETE", async () => {
    const { baseUrl } = await start();
    await post(baseUrl, { runId: "run-c", env: { FAKE_SLEEP_MS: "10000" }, timeoutSec: 60 });
    await waitFor(
      () => get(baseUrl, "run-c").then((r) => r.json() as Promise<RunBody>),
      (v) => v.status === "running",
    );
    const cancelRes = await del(baseUrl, "run-c");
    expect(cancelRes.status).toBe(204);

    const exited = await waitFor(
      () => get(baseUrl, "run-c").then((r) => r.json() as Promise<RunBody>),
      (v) => v.status === "exited",
    );
    expect(exited.reason).toBe("cancelled");
  });

  it("kills a run that exceeds its timeout with code 137 / reason timeout", async () => {
    const { baseUrl } = await start();
    await post(baseUrl, { runId: "run-d", env: { FAKE_SLEEP_MS: "5000" }, timeoutSec: 1 });
    const exited = await waitFor(
      () => get(baseUrl, "run-d").then((r) => r.json() as Promise<RunBody>),
      (v) => v.status === "exited",
      5000,
    );
    expect(exited.code).toBe(137);
    expect(exited.reason).toBe("timeout");
  });

  it("removes the workspace dir after the run exits", async () => {
    const { baseUrl, workspaceDir } = await start();
    await post(baseUrl, { runId: "run-e", env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "10" }, timeoutSec: 30 });
    await waitFor(
      () => get(baseUrl, "run-e").then((r) => r.json() as Promise<RunBody>),
      (v) => v.status === "exited",
    );
    expect(fs.existsSync(path.join(workspaceDir, "run-e"))).toBe(false);
  });

  it("keeps a WORKSPACE_KEY workspace dir after the run exits and reuses it for the next run", async () => {
    const { baseUrl, workspaceDir } = await start();
    for (const runId of ["run-k1", "run-k2"]) {
      await post(baseUrl, { runId, env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "10", WORKSPACE_KEY: "conv-abc" }, timeoutSec: 30 });
      await waitFor(
        () => get(baseUrl, runId).then((r) => r.json() as Promise<RunBody>),
        (v) => v.status === "exited",
      );
    }
    expect(fs.existsSync(path.join(workspaceDir, "conv-abc"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, "run-k1"))).toBe(false);
  });

  it("lists runs with capacity/running/queued and per-run status", async () => {
    const { baseUrl } = await start({ maxConcurrency: 2 });
    await post(baseUrl, { runId: "run-f", env: { FAKE_EXIT: "0", FAKE_SLEEP_MS: "200" }, timeoutSec: 30 });
    const res = await listRuns(baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capacity: number; running: number; queued: number; runs: RunBody[] };
    expect(body.capacity).toBe(2);
    expect(body.queued).toBe(0);
    const run = body.runs.find((r) => r.runId === "run-f");
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBeDefined();
  });

  it("401s GET /runs without a valid bearer token", async () => {
    const { baseUrl } = await start();
    const res = await listRuns(baseUrl, "wrong");
    expect(res.status).toBe(401);
  });

  it("GET /runs/:id/logs returns the tail of the run's output, oldest first, and needs the token", async () => {
    const { baseUrl } = await start();
    await post(baseUrl, { runId: "run-logs", env: {}, timeoutSec: 30, command: ["sh", "-c", "for i in 1 2 3 4 5; do echo line$i; done; echo oops >&2"] });
    await waitFor(() => get(baseUrl, "run-logs").then((r) => r.json() as Promise<RunBody>), (b) => b.status === "exited");
    const logs = (tail: number) => fetch(`${baseUrl}/runs/run-logs/logs?tail=${tail}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await waitFor(async () => ((await (await logs(100)).json()) as { lines: string[] }).lines, (l) => l.length === 6);
    expect(((await (await logs(100)).json()) as { lines: string[] }).lines.sort()).toEqual(["line1", "line2", "line3", "line4", "line5", "oops"]);
    expect(((await (await logs(2)).json()) as { lines: string[] }).lines).toHaveLength(2);
    expect((await fetch(`${baseUrl}/runs/nope/logs`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${baseUrl}/runs/run-logs/logs`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("reports health without auth", async () => {
    const { baseUrl } = await start({ maxConcurrency: 2 });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; running: number; queued: number; capacity: number };
    expect(body).toEqual({ ok: true, running: 0, queued: 0, capacity: 2 });
  });
});
