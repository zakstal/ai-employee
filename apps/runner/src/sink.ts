import type { RunnerEvent } from "@ai-employee/core";

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 50;
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

type FetchImpl = typeof fetch;

/**
 * Batches RunnerEvents and POSTs them to the control plane. Retries
 * transient failures (network error, 429, 5xx) with backoff, then drops the
 * batch and moves on. Flushes are serialized so batches always land in push
 * order even while one is mid-retry.
 */
export class EventSink {
  private queue: RunnerEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  push(ev: RunnerEvent): void {
    if (this.closed) return;
    this.queue.push(ev);
    if (this.queue.length >= MAX_BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce());
    return this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private async flushOnce(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    await this.send(batch);
  }

  private async send(batch: RunnerEvent[]): Promise<void> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
        if (res.ok) return;
        if (res.status === 429 || res.status >= 500) {
          if (attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]!);
            continue;
          }
          console.error(`[sink] dropping batch of ${batch.length} after ${attempt + 1} attempts: HTTP ${res.status}`);
          return;
        }
        console.error(`[sink] dropping batch of ${batch.length}: HTTP ${res.status}`);
        return;
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        console.error(`[sink] dropping batch of ${batch.length} after ${attempt + 1} attempts:`, err);
        return;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
