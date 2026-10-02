import pg from "pg";
import { migrate } from "./db/migrate.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://ai:ai@localhost:5432/ai_employee_test";
export const TEST_DBOS_URL = process.env.TEST_DBOS_DATABASE_URL ?? "postgres://ai:ai@localhost:5432/ai_employee_test_dbos";

/** Drop+create both test databases and migrate the app one. Needs local Postgres from `make dev`. */
export async function resetTestDatabases(): Promise<void> {
  for (const url of [TEST_DB_URL, TEST_DBOS_URL]) {
    const dbName = new URL(url).pathname.slice(1);
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await c.end();
    }
  }
  await migrate(TEST_DB_URL);
}
