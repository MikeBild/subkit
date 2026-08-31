// Test isolation helper.
//
// Strategy: CREATE DATABASE per test file. One admin connection drops +
// re-creates a throwaway database named `test_<pid>_<rand>`, the test file
// opens its own pool against that database, runs the embedded migration
// bundle (the same one the engine binary uses), hands a drizzle client
// back to the caller, and drops the database in the teardown hook. This
// is simpler than schema-scoped isolation. Historical migrations are replayed
// with an explicit public search path; the final migration moves only the
// product-owned objects into the isolated schema.
//
// Tests that share a file share a database — bun-test runs tests in a
// file serially by default. Different files get different databases so
// parallel file execution is safe.

import { setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { createMigrationDbFromUrl } from "../client.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import * as schema from "../schema/index.ts";

const { Client, Pool } = pg;

// Database-backed suites create and drop full migrated databases. Under
// the release gate's parallel file runner, Postgres can serialize drops
// behind other admin work, so use the same hook budget as journey tests.
export const TEST_DB_HOOK_TIMEOUT = 120_000;
setDefaultTimeout(TEST_DB_HOOK_TIMEOUT);

// Orphan sweep — runs at most once per bun test process. Killed runs
// (Ctrl-C, OOM, timeout) leave test_* databases behind. Without a
// sweep, the catalog grows unbounded across days; CREATE DATABASE in
// the next run serialises on the shared catalog lock, and a fresh
// run can take 1h+ to finish what normally takes minutes. The
// observed pathology: 563 orphans pushed the journey suite into
// terminal lock-wait.
//
// Safety, part 1: only drop databases that have no active connections.
// The match is gated to the `test_` prefix so production data is
// untouched.
//
// Safety, part 2 — the OWNING PID. "A concurrent run always has a
// connection open" is false for a window of its own making:
// `createTestDb` closes its admin connection right after CREATE
// DATABASE, and `new Pool()` does not dial until the first query. In
// between, a perfectly healthy brand-new database has ZERO rows in
// pg_stat_activity and looks exactly like an orphan. Under the release
// gate — 1432 files, each spawning a process that runs this sweep once
// — that window gets hit: a sibling process dropped a live database out
// from under its owner and the suite died with
// `3D000 database "test_conv_chat_rehydrate_<pid>_…" does not exist`
// ("It seems to have just been dropped or renamed").
//
// The database name carries the pid of the process that created it, and
// an orphan is by definition the leftover of a process that is GONE. So
// a name whose pid is still alive is never swept, connections or not.
// Both gates apply; neither alone is sufficient.
// Fast reachability preflight — runs at most once per bun test process.
// Database-backed suites are useless without Postgres, but a missing
// server otherwise surfaces as a per-file connect-timeout cascade that
// takes minutes and buries the actual problem. Probe once with a short
// timeout and fail the suite with the fix instead.
let _preflightPromise: Promise<void> | null = null;
async function preflightPostgres(adminUrl: string): Promise<void> {
  const probe = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await probe.connect();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PostgreSQL is not reachable at ${adminUrl.replace(/\/\/[^@]*@/, "//<credentials>@")} — ` +
        `database-backed tests need it. Run \`bun run compose:up\` first ` +
        `(see CONTRIBUTING.md), or point DATABASE_URL at a running server.` +
        (cause ? ` (probe error: ${cause})` : ""),
    );
  } finally {
    await probe.end().catch(() => {});
  }
}
function ensurePreflight(adminUrl: string): Promise<void> {
  if (!_preflightPromise) _preflightPromise = preflightPostgres(adminUrl);
  return _preflightPromise;
}

let _orphanSweepPromise: Promise<void> | null = null;
/**
 * The pid `createTestDb` stamped into a database name, or null when the
 * name predates the convention. Layout is
 * `test_<label>_<pid>_<rand>`; the label may itself contain
 * underscores, so the pid is the second-to-last segment.
 */
export function owningPidFromTestDbName(datname: string): number | null {
  const parts = datname.split("_");
  if (parts.length < 4) return null;
  const candidate = parts[parts.length - 2] ?? "";
  if (!/^\d+$/.test(candidate)) return null;
  const pid = Number(candidate);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Signal 0 probes for existence without delivering anything. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user —
    // still alive, still not ours to sweep.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
      const pid = owningPidFromTestDbName(datname);
      // A live owner means the database is either in use or in the
      // connectionless window right after CREATE DATABASE. Either way
      // it is not an orphan.
      if (pid !== null && isPidAlive(pid)) continue;
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

export interface CreateTestDbOptions {
  /**
   * Stop after the migration with this index, leaving the database in
   * the state a deployment had before the next one ran. Without it a
   * data migration can only be inspected after the fact — by which time
   * the rows it read are gone and the transform itself is unprovable.
   * The runner applies migrations by tag membership, so a later
   * `runMigrations(db)` with the full set applies exactly the remainder.
   */
  upToIdx?: number;
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
export async function createTestDb(
  label: string,
  options: CreateTestDbOptions = {},
): Promise<TestDb> {
  const rand = randomBytes(6).toString("hex");
  const dbName = `test_${label}_${process.pid}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  const adminUrl = getAdminUrl();
  // First call in this process probes reachability (fast, friendly
  // failure when Postgres is down) and sweeps orphaned databases from
  // prior killed runs. Subsequent calls share the cached promises —
  // zero overhead.
  await ensurePreflight(adminUrl);
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
  // The embedded migration runner installs pgcrypto + the drizzle journal
  // table itself; no extra prep needed. Apply the historical lineage with the
  // default search path, then create the same isolated runtime pool as the
  // compiled server.
  const upToIdx = options.upToIdx;
  const migration = createMigrationDbFromUrl(url);
  try {
    await runMigrations(
      migration.db,
      upToIdx === undefined
        ? EMBEDDED_MIGRATIONS
        : EMBEDDED_MIGRATIONS.filter((m) => m.idx <= upToIdx),
      // Replaying the lineage from scratch, exactly like a fresh deployment:
      // the pre-isolation migrations must build in `public` before 0041 moves
      // the owned set into `subkit`.
      true,
    );
  } finally {
    await migration.pool.end();
  }

  // Production takes the search path from the database ROLE, because a pooler
  // in transaction mode rejects startup parameters. Tests connect straight to
  // PostgreSQL with no pooler in between, so a startup option is safe here,
  // and stating it explicitly stops a role default from silently changing what
  // the harness sees.
  //
  // One path covers both cases: a half-applied lineage still has its objects
  // in `public` and falls through to it, while a fully applied one finds them
  // in `subkit` first. This is exactly what the previous default (`"$user",
  // public` with a role named subkit) resolved to.
  const pool = new Pool({
    connectionString: url,
    options: "-c search_path=subkit,pg_catalog,public",
  });
  // Swallow async errors so a connection hiccup doesn't crash the runner.
  pool.on("error", () => {});

  const db = drizzle(pool, { schema });

  // Seed the RBAC catalog + built-in roles so `can()` has something to
  // evaluate even in unit tests that bypass the journey harness.
  await seedBuiltinRolesAndPermissions(db);

  const cleanup = async () => {
    const admin2 = new Client({ connectionString: getAdminUrl() });
    await admin2.connect();
    try {
      // Terminate lingering or in-flight clients BEFORE awaiting pool.end().
      // Waiting on the pool first deadlocks teardown when a fire-and-forget
      // query still owns a client: the backend termination that would reject
      // that query was only attempted after the wait. Once terminated, pg
      // rejects the query, releases its client, and the pool drains normally.
      await admin2.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      // `pg_terminate_backend` rejects ordinary `pool.query()` calls and
      // they release themselves. Still, a client checked out by a leaked
      // fire-and-forget task can remain in pg-pool's bookkeeping after its
      // backend is already gone, causing `pool.end()` to wait forever. Give
      // normal error propagation a short turn, then remove only those
      // already-terminated clients through pg-pool's internal cleanup hook.
      // This is deliberately confined to disposable test pools.
      const internalPool = pool as pg.Pool & {
        _clients?: pg.PoolClient[];
        _remove?: (client: pg.PoolClient, callback?: () => void) => void;
      };
      const endPromise = pool.end().catch(() => {});
      const endedNormally = await Promise.race([
        endPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (!endedNormally && internalPool._clients && internalPool._remove) {
        for (const client of [...internalPool._clients]) internalPool._remove(client);
        await endPromise;
      }
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin2.end();
    }
  };

  return { dbName, url, pool, db, cleanup };
}
