import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The warm runner's HTTP control surface. Runs on an always-on box; each
 * request spawns a child `node dist/index.js` process (RUNNER_MODE=task,
 * unset) that behaves exactly like the per-task container entrypoint, just
 * without the container.
 */

const KILL_ESCALATION_MS = 10_000;
const DROP_AFTER_MS = 60 * 60 * 1000;
/** Lines of child output kept per run for GET /runs/:id/logs (operators read the tail of a live or just-ended run). */
const LOG_LINES_KEPT = 1000;

type RunStatus = "queued" | "running" | "exited";

interface RunRecord {
  runId: string;
  status: RunStatus;
  env: Record<string, string>;
  timeoutSec: number;
  command?: string[] | undefined;
  code?: number;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  child?: ChildProcess;
  workspaceDir?: string;
  keepWorkspace?: boolean;
  logs: string[];
  killReason?: "timeout" | "cancelled";
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killEscalationTimer?: ReturnType<typeof setTimeout>;
  dropTimer?: ReturnType<typeof setTimeout>;
}

export interface ServerOptions {
  token: string;
  maxConcurrency: number;
  workspaceDir: string;
  /** Script to spawn for each run. Default: this same dist/index.js. */
  childScript: string;
}

function defaultChildScript(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const token = env.RUNNER_TOKEN;
  if (!token) throw new Error("RUNNER_TOKEN is required when RUNNER_MODE=server");
  return {
    token,
    maxConcurrency: Number(env.RUNNER_MAX_CONCURRENCY ?? 4),
    workspaceDir: env.WORKSPACE_DIR ?? "/workspace",
    childScript: env.RUNNER_CHILD_SCRIPT ?? defaultChildScript(),
  };
}

export interface ServerHandle {
  server: http.Server;
  /** Resolves once no run is "running", or timeoutMs elapses. Doesn't close the server. */
  drain(timeoutMs?: number): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function sanitize(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "run";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function pipeLines(stream: NodeJS.ReadableStream | null, record: RunRecord): void {
  if (!stream) return;
  createInterface({ input: stream }).on("line", (line) => {
    process.stderr.write(`[run ${record.runId}] ${line}\n`);
    record.logs.push(line);
    if (record.logs.length > LOG_LINES_KEPT) record.logs.shift();
  });
}

function toResponse(record: RunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    status: record.status,
    ...(record.code !== undefined ? { code: record.code } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
  };
}

export function createServer(opts: ServerOptions): ServerHandle {
  const runs = new Map<string, RunRecord>();
  const queue: string[] = [];
  let runningCount = 0;

  function finalizeExit(record: RunRecord, code: number, reason?: string): void {
    record.status = "exited";
    record.code = code;
    if (reason) record.reason = reason;
    record.endedAt = now();
    record.dropTimer = setTimeout(() => runs.delete(record.runId), DROP_AFTER_MS);
    record.dropTimer.unref();
  }

  function killWithEscalation(record: RunRecord, reason: "timeout" | "cancelled"): void {
    if (!record.child) return;
    record.killReason = reason;
    record.child.kill("SIGTERM");
    record.killEscalationTimer = setTimeout(() => record.child?.kill("SIGKILL"), KILL_ESCALATION_MS);
    record.killEscalationTimer.unref();
  }

  function startRun(record: RunRecord): void {
    record.status = "running";
    record.startedAt = now();
    runningCount++;

    // WORKSPACE_KEY (e.g. one per conversation) → a stable dir that survives the run, so repos stay cloned
    // and Claude Code's session transcript (keyed by cwd) can be resumed. No key → per-run dir, removed on exit.
    const workspaceKey = record.env.WORKSPACE_KEY;
    const workspaceDir = path.join(opts.workspaceDir, sanitize(workspaceKey || record.runId));
    record.workspaceDir = workspaceDir;
    record.keepWorkspace = Boolean(workspaceKey);
    mkdirSync(workspaceDir, { recursive: true });

    // Never forward the server's own token or server mode into the child.
    const restEnv = { ...record.env };
    delete restEnv.RUNNER_TOKEN;
    delete restEnv.RUNNER_MODE;
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...restEnv,
      WORKSPACE_DIR: workspaceDir,
      RUNNER_MODE: "task",
    };

    const [cmd, ...args] =
      record.command && record.command.length > 0 ? record.command : [process.execPath, opts.childScript];
    const child = spawn(cmd!, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    record.child = child;

    pipeLines(child.stdout, record);
    pipeLines(child.stderr, record);

    record.timeoutTimer = setTimeout(() => killWithEscalation(record, "timeout"), record.timeoutSec * 1000);
    record.timeoutTimer.unref();

    let settled = false;
    const onDone = (code: number, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(record.timeoutTimer);
      if (record.killEscalationTimer) clearTimeout(record.killEscalationTimer);
      runningCount--;
      finalizeExit(record, code, reason);
      const dir = record.workspaceDir;
      if (dir && !record.keepWorkspace) void rm(dir, { recursive: true, force: true }).catch(() => {});
      pump();
    };

    child.on("error", (err) => onDone(127, err.message));
    child.on("exit", (code, signal) => {
      if (record.killReason === "timeout") onDone(137, "timeout");
      else if (record.killReason === "cancelled") onDone(137, "cancelled");
      else if (signal) onDone(137, signal);
      else onDone(code ?? 1);
    });
  }

  function pump(): void {
    while (runningCount < opts.maxConcurrency && queue.length > 0) {
      const runId = queue.shift()!;
      const record = runs.get(runId);
      if (!record || record.status !== "queued") continue;
      startRun(record);
    }
  }

  async function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const body = parsed as { runId?: unknown; env?: unknown; timeoutSec?: unknown; command?: unknown };
    if (
      typeof body.runId !== "string" ||
      !body.runId ||
      typeof body.timeoutSec !== "number" ||
      typeof body.env !== "object" ||
      body.env === null
    ) {
      sendJson(res, 400, { error: "runId, env, timeoutSec are required" });
      return;
    }

    const existing = runs.get(body.runId);
    if (existing) {
      sendJson(res, 200, toResponse(existing));
      return;
    }

    const record: RunRecord = {
      runId: body.runId,
      status: "queued",
      logs: [],
      env: body.env as Record<string, string>,
      timeoutSec: body.timeoutSec,
      command: Array.isArray(body.command) ? (body.command as string[]) : undefined,
    };
    runs.set(record.runId, record);
    queue.push(record.runId);
    pump();
    sendJson(res, 202, toResponse(record));
  }

  function handleListRuns(res: http.ServerResponse): void {
    sendJson(res, 200, {
      capacity: opts.maxConcurrency,
      running: runningCount,
      queued: queue.length,
      runs: Array.from(runs.values()).map(toResponse),
    });
  }

  function handleGet(runId: string, res: http.ServerResponse): void {
    const record = runs.get(runId);
    if (!record) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, toResponse(record));
  }

  function handleLogs(runId: string, url: URL, res: http.ServerResponse): void {
    const record = runs.get(runId);
    if (!record) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const tail = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("tail") ?? 100)) || 100, 1), LOG_LINES_KEPT);
    sendJson(res, 200, { runId, lines: record.logs.slice(-tail) });
  }

  function handleCancel(runId: string, res: http.ServerResponse): void {
    const record = runs.get(runId);
    if (!record) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (record.status === "queued") {
      const idx = queue.indexOf(runId);
      if (idx >= 0) queue.splice(idx, 1);
      finalizeExit(record, 137, "cancelled");
    } else if (record.status === "running") {
      killWithEscalation(record, "cancelled");
    }
    res.writeHead(204);
    res.end();
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, running: runningCount, queued: queue.length, capacity: opts.maxConcurrency });
      return;
    }

    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      await handleCreate(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      handleListRuns(res);
      return;
    }
    const logs = /^\/runs\/([^/]+)\/logs$/.exec(url.pathname);
    if (logs && req.method === "GET") return handleLogs(decodeURIComponent(logs[1]!), url, res);
    const m = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const runId = decodeURIComponent(m[1]!);
      if (req.method === "GET") return handleGet(runId, res);
      if (req.method === "DELETE") return handleCancel(runId, res);
    }
    sendJson(res, 404, { error: "not found" });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  function drain(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = (): void => {
        if (runningCount === 0 || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 200).unref();
      };
      check();
    });
  }

  return { server, drain };
}

export function startServer(opts: ServerOptions = optionsFromEnv()): ServerHandle {
  const handle = createServer(opts);
  const port = Number(process.env.RUNNER_PORT ?? 8080);
  handle.server.listen(port, () => {
    process.stderr.write(`[runner] server listening on :${port}\n`);
  });
  process.on("SIGTERM", () => {
    handle.server.close();
    void handle.drain(30_000).then(() => process.exit(0));
  });
  return handle;
}
