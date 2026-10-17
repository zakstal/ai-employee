/** Errors a fresh connection would not have: the socket died under us, or the Cloud SQL proxy could not dial. */
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03"]);
const TRANSIENT_MESSAGE = /connection terminated|connection.*(closed|reset|refused|ended)|server closed the connection|timeout.*connect|connect.*timeout|dial (error|tcp)|failed to connect|ECONNRESET/i;

export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && (TRANSIENT_CODES.has(code) || code.startsWith("08"))) return true; // 08xxx: connection exception
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message);
}

/**
 * Runs an IDEMPOTENT db operation, once more on a transient connection error. The pool discards the broken
 * client, so the retry gets a fresh connection. Never wrap something that is not safe to run twice.
 */
export async function retryTransient<T>(fn: () => Promise<T>, opts: { retries?: number; delayMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isTransientDbError(e)) throw e;
      console.warn(`transient db error, retrying (${attempt + 1}/${retries}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 200));
    }
  }
}
