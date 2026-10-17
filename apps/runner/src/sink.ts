import type { RunnerEvent } from "@ai-employee/core";

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 50;
/** Backoff doubles from the first delay up to the cap; a batch is retried until the budget is spent. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_DELAY_MS = 15_000;
/** Long enough to ride out a control-plane deploy/restart (~5 min), short enough that a dead one does not hold a sandbox forever. */
const DEFAULT_RETRY_BUDGET_MS = 5 * 60_000;

type FetchImpl = typeof fetch;

export interface EventSinkOptions {
  /** Total time one batch may spend retrying before it is dropped. */
  retryBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Batches RunnerEvents and POSTs them to the control plane. Connection errors, 429 and 5xx (a control plane that is
 * restarting answers 502-504 or refuses connections) are retried with capped exponential backoff for up to
 * `retryBudgetMs`; any other 4xx drops the batch (retrying cannot fix it). Flushes are serialized, so a batch that is
 * mid-retry holds back everything pushed after it: events always land in push order, and the control plane
 * dedupes a repeated (run, seq). The queue is in memory only.
 * ponytail: the queue is unbounded while the control plane is down; cap it if a runner ever emits enough to matter.
 */
export class EventSink {
  private queue: RunnerEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly retryBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchImpl = fetch,
    opts: EventSinkOptions = {},
  ) {
    this.retryBudgetMs = opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    this.sleep = opts.sleep ?? sleep;
    this.now = opts.now ?? Date.now;
  }

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
    const deadline = this.now() + this.retryBudgetMs;
    let delay = FIRST_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
        });
        if (res.ok) return;
        if (res.status !== 429 && res.status < 500) {
          console.error(`[sink] dropping batch of ${batch.length}: HTTP ${res.status}`);
          return;
        }
        failure = `HTTP ${res.status}`;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (this.now() + delay > deadline) {
        console.error(`[sink] dropping batch of ${batch.length} after ${attempt} attempts over ${Math.round(this.retryBudgetMs / 1000)}s: ${failure}`);
        return;
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
