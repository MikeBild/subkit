// Test isolation helper.
//
// Strategy: CREATE DATABASE per test file. One admin connection drops +
// re-creates a throwaway database named `test_<pid>_<rand>`, the test file
// opens its own pool against that database, runs the embedded migration
// bundle (the same one the engine binary uses), hands a drizzle client
// back to the caller, and drops the database in the teardown hook. This
// is simpler than schema-scoped isolation because drizzle-kit's
// migration SQL is not search_path-friendly (enum types end up in
// `public` regardless).
//
// Tests that share a file share a database — bun-test runs tests in a
// file serially by default. Different files get different databases so
// parallel file execution is safe.

import { randomBytes } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { runMigrations } from "../migrate.ts";
import * as schema from "../schema/index.ts";

const { Client, Pool } = pg;

/** Read the admin connection string lazily so tests can override
 *  DATABASE_URL between imports. */
function getAdminUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://subkit:subkit@localhost:5432/subkit";
}

function rewriteDbName(url: string, newName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${newName}`;
  return parsed.toString();
}

export type TestDb = {
  dbName: string;
  url: string;
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  cleanup: () => Promise<void>;
};

/**
 * Create a disposable database, run migrations against it, and return a
 * drizzle client bound to it. Caller must invoke `cleanup()` in
 * afterAll.
 */
export async function createTestDb(label: string): Promise<TestDb> {
  const rand = randomBytes(6).toString("hex");
  const dbName = `test_${label}_${process.pid}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  const adminUrl = getAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const url = rewriteDbName(adminUrl, dbName);
  const pool = new Pool({ connectionString: url });
  // Swallow async errors so a connection hiccup doesn't crash the runner.
  pool.on("error", () => {});

  const db = drizzle(pool, { schema });
  // The embedded migration runner installs pgcrypto + the drizzle journal
  // table itself; no extra prep needed.
  await runMigrations(db);

  // Seed the RBAC catalog + built-in roles so `can()` has something to
  // evaluate even in unit tests that bypass the journey harness.
  await seedBuiltinRolesAndPermissions(db);

  const cleanup = async () => {
    await pool.end().catch(() => {});
    const admin2 = new Client({ connectionString: getAdminUrl() });
    await admin2.connect();
    try {
      // Terminate any lingering connections before DROP.
      await admin2.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin2.end();
    }
  };

  return { dbName, url, pool, db, cleanup };
}
