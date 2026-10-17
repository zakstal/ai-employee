import pg from "pg";

let pool: pg.Pool | undefined;

export function poolOptions(url: string): pg.PoolConfig {
  return {
    connectionString: url,
    max: 10,
    // Idle sockets die silently behind the Cloud SQL proxy / NAT: probe them, and drop them before the other side does.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

/** An idle client erroring (server restart, proxy reset) is emitted on the pool; unhandled, it would crash the process. The pool already discards that client. */
export function attachPoolErrorHandler(p: pg.Pool): void {
  p.on("error", (err) => console.error("pg pool: idle client error (client discarded)", err.message));
}

export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!url) throw new Error("DATABASE_URL unset");
    pool = new pg.Pool(poolOptions(url));
    attachPoolErrorHandler(pool);
  }
  return pool;
}
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
