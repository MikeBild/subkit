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

// Orphan sweep — runs at most once per bun test process. Killed runs
// (Ctrl-C, OOM, timeout) leave test_* databases behind. Without a
// sweep, the catalog grows unbounded across days; CREATE DATABASE in
// the next run serialises on the shared catalog lock, and a fresh
// run can take 1h+ to finish what normally takes minutes. The
// observed pathology: 563 orphans pushed the journey suite into
// terminal lock-wait.
//
// Safety: only drop databases that have no active connections. A
// concurrent test run's database has its admin/pool connection open,
// so it shows up in pg_stat_activity and is skipped. The match is
// gated to the `test_` prefix so production data is untouched.
let _orphanSweepPromise: Promise<void> | null = null;
async function sweepOrphanTestDatabases(adminUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'test\\_%' ESCAPE '\\'
          AND NOT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE pg_stat_activity.datname = pg_database.datname
          )`,
    );
    for (const { datname } of rows) {
      // Identifier comes from pg_database catalog with the test_ prefix
      // already gated above; safe to interpolate into the DDL.
      await admin.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => {});
    }
  } finally {
    await admin.end().catch(() => {});
  }
}
function ensureOrphanSweep(adminUrl: string): Promise<void> {
  if (!_orphanSweepPromise) _orphanSweepPromise = sweepOrphanTestDatabases(adminUrl);
  return _orphanSweepPromise;
}

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
  // First call in this process sweeps orphaned databases from prior
  // killed runs. Subsequent calls share the cached promise — zero
  // overhead.
  await ensureOrphanSweep(adminUrl);
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
