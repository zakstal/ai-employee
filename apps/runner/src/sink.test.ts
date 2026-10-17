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

  describe("riding out a control-plane restart", () => {
    const manual = () => {
      let t = 0;
      const sleeps: number[] = [];
      return { sleeps, opts: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } } };
    };
    const bodyOf = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { events: RunnerEvent[] }).events;

    it("retries refused connections and 502/503/504 with capped backoff, then delivers the batch once", async () => {
      const { sleeps, opts } = manual();
      const delivered: RunnerEvent[][] = [];
      const script: (Error | number)[] = [new TypeError("fetch failed"), 502, 503, 504, 503, 503, 503, 503];
      const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
        const next = script.shift();
        if (next instanceof Error) throw next;
        if (typeof next === "number") return new Response("", { status: next });
        delivered.push(bodyOf(init));
        return new Response("{}", { status: 202 });
      });
      const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch, opts);
      sink.push(ev(1));
      await sink.close();
      expect(delivered).toEqual([[ev(1)]]);
      expect(sleeps).toEqual([250, 500, 1000, 2000, 4000, 8000, 15000, 15000].slice(0, sleeps.length));
      expect(Math.max(...sleeps)).toBe(15000);
    });

    it("keeps events in order: events pushed while a batch is retrying are sent after it", async () => {
      const { opts } = manual();
      const order: number[] = [];
      let down = 2;
      const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
        if (down-- > 0) return new Response("", { status: 503 });
        order.push(...bodyOf(init).map((e) => e.seq));
        return new Response("{}", { status: 202 });
      });
      const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch, opts);
      sink.push(ev(1));
      const first = sink.flush(); // retrying
      sink.push(ev(2));
      const second = sink.flush(); // queued behind it
      sink.push(ev(3));
      await sink.close();
      await Promise.all([first, second]);
      expect(order).toEqual([1, 2, 3]);
    });

    it("gives up and drops the batch only after the ~5 minute budget", async () => {
      const { sleeps, opts } = manual();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
      const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch, opts);
      sink.push(ev(1));
      await sink.close();
      const waited = sleeps.reduce((a, b) => a + b, 0);
      expect(waited).toBeGreaterThan(4 * 60_000);
      expect(waited).toBeLessThanOrEqual(5 * 60_000);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("dropping batch of 1"));
      err.mockRestore();
    });

    it("drops a batch the control plane rejects (4xx other than 429) without retrying", async () => {
      const { sleeps, opts } = manual();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
      const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch, opts);
      sink.push(ev(1));
      await sink.close();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      err.mockRestore();
    });

    it("retries 429", async () => {
      const { opts } = manual();
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("{}", { status: 202 }));
      const sink = new EventSink("http://sink.test/events", "tok", fetchImpl as unknown as typeof fetch, opts);
      sink.push(ev(1));
      await sink.close();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
