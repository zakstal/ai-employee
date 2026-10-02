import pg from "pg";

let pool: pg.Pool | undefined;
export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!pool) {
    if (!url) throw new Error("DATABASE_URL unset");
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
