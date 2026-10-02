import { describe, expect, it, vi } from "vitest";
import type { RunnerEvent } from "@ai-employee/core";
import { EventSink } from "./sink.js";

function ev(seq: number): RunnerEvent {
  return { runId: "run-1", seq, ts: "2026-01-01T00:00:00.000Z", type: "assistant_text", text: `msg-${seq}` };
}

describe("EventSink", () => {
  it("batches events and flushes with the bearer token", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return new Response("{}", { status: 200 });
    });

    const sink = new EventSink("http://sink.test/events", "tok-123", fetchImpl as unknown as typeof fetch);
    sink.push(ev(1));
    sink.push(ev(2));
    await sink.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sink.test/events");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-123");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect((calls[0]!.body as { events: RunnerEvent[] }).events).toEqual([ev(1), ev(2)]);
  });

  it("flushes immediately once a batch reaches 50 events", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch);
    for (let i = 1; i <= 50; i++) sink.push(ev(i));
    // give the microtask/flush chain a tick without waiting for the 500ms timer
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await sink.close();
  });

  it("retries on a 503 then succeeds, without losing or reordering events", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const seenBatches: RunnerEvent[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      attempt++;
      if (attempt === 1) return new Response("service unavailable", { status: 503 });
      seenBatches.push((JSON.parse(String(init?.body)) as { events: RunnerEvent[] }).events);
      return new Response("{}", { status: 200 });
    });

    const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch);
    sink.push(ev(1));
    sink.push(ev(2));

    const closePromise = sink.close();
    // let the first (failing) attempt run, then advance past its 250ms backoff
    await vi.advanceTimersByTimeAsync(250);
    await closePromise;

    expect(attempt).toBe(2);
    expect(seenBatches).toEqual([[ev(1), ev(2)]]);
    vi.useRealTimers();
  });

  it("preserves order across multiple flushed batches", async () => {
    const seenBatches: RunnerEvent[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      seenBatches.push((JSON.parse(String(init?.body)) as { events: RunnerEvent[] }).events);
      return new Response("{}", { status: 200 });
    });
    const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch);

    sink.push(ev(1));
    await sink.flush();
    sink.push(ev(2));
    await sink.flush();
    sink.push(ev(3));
    await sink.close();

    expect(seenBatches).toEqual([[ev(1)], [ev(2)], [ev(3)]]);
  });
});
