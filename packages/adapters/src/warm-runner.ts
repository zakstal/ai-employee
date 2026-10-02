import type { RunExit, RunHandle, RunSpec, SandboxRuntime } from "@ai-employee/core";

type FetchImpl = typeof fetch;

const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export interface WarmRunnerRuntimeOptions {
  /** Base URL of a running apps/runner server (RUNNER_MODE=server), e.g. http://warm-box:8080 */
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  pollIntervalMs?: number;
}

interface RunResponseBody {
  runId: string;
  status: "queued" | "running" | "exited";
  code?: number;
  reason?: string;
}

/**
 * Talks to the warm runner's HTTP control surface (apps/runner/src/server.ts)
 * on an always-on box that runs many tasks as child processes.
 *
 * `spec.image` is ignored: the warm box already runs whatever runner image it
 * was started with, so there's nothing to pass along — only env, timeout,
 * and an optional command override travel over the wire.
 */
export class WarmRunnerRuntime implements SandboxRuntime {
  readonly name = "warm";
  private readonly cancelled = new Set<string>();

  constructor(private readonly opts: WarmRunnerRuntimeOptions) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    await this.request("POST", "/runs", {
      runId: spec.runId,
      env: spec.env,
      timeoutSec: spec.timeoutSec,
      command: spec.command,
    });
    return { adapter: this.name, externalId: spec.runId };
  }

  async wait(handle: RunHandle, opts?: { signal?: AbortSignal }): Promise<RunExit> {
    const interval = this.opts.pollIntervalMs ?? 1000;
    for (;;) {
      opts?.signal?.throwIfAborted();
      const body = (await this.request("GET", `/runs/${encodeURIComponent(handle.externalId)}`, undefined, {
        allow404: true,
      })) as RunResponseBody | null;
      if (body === null) {
        return { code: 1, reason: this.cancelled.has(handle.externalId) ? "cancelled" : "lost" };
      }
      if (body.status === "exited") {
        return body.reason !== undefined ? { code: body.code ?? 1, reason: body.reason } : { code: body.code ?? 1 };
      }
      await sleep(interval, opts?.signal);
    }
  }

  async cancel(handle: RunHandle): Promise<void> {
    this.cancelled.add(handle.externalId);
    await this.request("DELETE", `/runs/${encodeURIComponent(handle.externalId)}`, undefined, { allow404: true });
  }

  private get fetchImpl(): FetchImpl {
    return this.opts.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allow404?: boolean },
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw err;
      }

      if (res.status === 404 && opts?.allow404) return null;
      if (res.status >= 500 || res.status === 429) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw new Error(`warm runner: HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`warm runner: HTTP ${res.status}`);
      if (res.status === 204) return undefined;
      return await res.json();
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
