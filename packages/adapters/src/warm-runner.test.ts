import type { RunSpec } from "@ai-employee/core";
import { describe, expect, it, vi } from "vitest";
import { WarmRunnerRuntime } from "./warm-runner.js";

const spec: RunSpec = {
  runId: "run-1",
  image: "n/a",
  env: { FOO: "bar" },
  cpu: 1,
  memoryMb: 128,
  timeoutSec: 30,
  employeeId: "e1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WarmRunnerRuntime", () => {
  it("start posts to /runs and returns a handle keyed on runId", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://box:8080/runs");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
      const body = JSON.parse(String(init?.body)) as { runId: string };
      expect(body.runId).toBe("run-1");
      return jsonResponse(202, { runId: "run-1", status: "queued" });
    });
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    const handle = await rt.start(spec);
    expect(handle).toEqual({ adapter: "warm", externalId: "run-1" });
  });

  it("wait polls until exited and returns code/reason", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call < 3) return jsonResponse(200, { runId: "run-1", status: "running" });
      return jsonResponse(200, { runId: "run-1", status: "exited", code: 0 });
    });
    const rt = new WarmRunnerRuntime({
      baseUrl: "http://box:8080",
      token: "tok",
      fetchImpl: fetchImpl as typeof fetch,
      pollIntervalMs: 1,
    });
    const exit = await rt.wait({ adapter: "warm", externalId: "run-1" });
    expect(exit).toEqual({ code: 0, reason: undefined });
    expect(call).toBe(3);
  });

  it("wait surfaces reason from an exited run", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { runId: "run-1", status: "exited", code: 137, reason: "timeout" }));
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    const exit = await rt.wait({ adapter: "warm", externalId: "run-1" });
    expect(exit).toEqual({ code: 137, reason: "timeout" });
  });

  it("cancel DELETEs the run and ignores 404", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://box:8080/runs/run-1");
      expect(init?.method).toBe("DELETE");
      return jsonResponse(404, undefined);
    });
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    await expect(rt.cancel({ adapter: "warm", externalId: "run-1" })).resolves.toBeUndefined();
  });

  it("wait reports 'lost' on 404 when never cancelled", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, undefined));
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    const exit = await rt.wait({ adapter: "warm", externalId: "run-1" });
    expect(exit).toEqual({ code: 1, reason: "lost" });
  });

  it("wait reports 'cancelled' on 404 after cancel() was called", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => jsonResponse(init?.method === "DELETE" ? 204 : 404, undefined));
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    await rt.cancel({ adapter: "warm", externalId: "run-1" });
    const exit = await rt.wait({ adapter: "warm", externalId: "run-1" });
    expect(exit).toEqual({ code: 1, reason: "cancelled" });
  });

  it("retries transient network errors and 5xx before succeeding", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error("ECONNRESET");
      if (call === 2) return jsonResponse(503, undefined);
      return jsonResponse(202, { runId: "run-1", status: "queued" });
    });
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    const handle = await rt.start(spec);
    expect(handle).toEqual({ adapter: "warm", externalId: "run-1" });
    expect(call).toBe(3);
  }, 10_000);

  it("gives up after exhausting retries", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, undefined));
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as typeof fetch });
    await expect(rt.start(spec)).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  }, 15_000);

  it("status maps the runner's record: running (queued too), ended with code/times, and lost on 404", async () => {
    const handle = { adapter: "warm", externalId: "run-1" };
    const bodies: Record<string, unknown> = {
      queued: { runId: "run-1", status: "queued" },
      running: { runId: "run-1", status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
      exited: { runId: "run-1", status: "exited", code: 137, reason: "timeout", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:05:00.000Z" },
    };
    let next = "queued";
    const fetchImpl = vi.fn(async () => (next === "gone" ? jsonResponse(404, { error: "not found" }) : jsonResponse(200, bodies[next])));
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await rt.status(handle)).toEqual({ state: "running" });
    next = "running";
    expect(await rt.status(handle)).toEqual({ state: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    next = "exited";
    expect(await rt.status(handle)).toEqual({ state: "ended", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:05:00.000Z", exitCode: 137, reason: "timeout" });
    next = "gone";
    expect(await rt.status(handle)).toEqual({ state: "lost" });
  });

  it("logs GETs /runs/:id/logs?tail=N", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("http://box:8080/runs/run-1/logs?tail=3");
      return jsonResponse(200, { runId: "run-1", lines: ["a", "b", "c"] });
    });
    const rt = new WarmRunnerRuntime({ baseUrl: "http://box:8080", token: "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await rt.logs({ adapter: "warm", externalId: "run-1" }, { tail: 3 })).toEqual(["a", "b", "c"]);
  });
});
