// Drizzle client over node-postgres. A single shared Pool plus a typed
// `db` wrapper. Pool stats and connection errors are logged under module=db.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import * as schema from "./schema/index.ts";

const { Pool } = pg;
export const SUBKIT_DATABASE_OPTIONS = "-c search_path=subkit,pg_catalog,public";
export const SUBKIT_MIGRATION_DATABASE_OPTIONS = "-c search_path=public,pg_catalog";

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

/**
 * Lazy pool factory — creates a connection pool the first time the db is
 * touched. Tests may call `createDbFromUrl()` directly to get an isolated
 * instance against a disposable database.
 *
 * In production, canonical `database.url` always wins. DATABASE_URL remains
 * a bootstrap import when that leaf is initially absent. Test processes may
 * explicitly pin DATABASE_URL to an isolated database before touching the
 * shared pool; production never uses that test seam after config is loaded.
 */
export function getPool(): pg.Pool {
  if (_pool) return _pool;
  let url = "";
  if (process.env.NODE_ENV === "test") url = process.env.DATABASE_URL ?? "";
  if (!url) {
    try {
      url = getConfig().database.url;
    } catch {
      url = "";
    }
  }
  if (!url) url = process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error(
      "database.url is not set. Configure via `sk settings set database.url '\"…\"'` or set DATABASE_URL.",
    );
  }
  _pool = new Pool({ connectionString: url, options: SUBKIT_DATABASE_OPTIONS });
  _pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "pool.error",
      msg: "postgres pool emitted error",
      error: err.message,
    });
  });
  logger.debug({
    module: "db",
    action: "pool.created",
    msg: "postgres pool created",
  });
  return _pool;
}

/**
 * Wrap a drizzle db so every `db.transaction(...)` records its duration
 * and outcome via `instrument()` (debug + 500ms threshold, so only SLOW
 * transactions surface in the log stream while the histogram records all).
 *
 * Implemented as a `Proxy` over the `transaction` method only: the
 * returned value is still typed (and behaves) as `Db`, the generic return
 * type of the user callback is preserved, and `instrument()` re-throws on
 * failure — so drizzle's rollback-on-throw semantics are untouched.
 */
function instrumentTransactions(db: NodePgDatabase<typeof schema>): NodePgDatabase<typeof schema> {
  const original = db.transaction.bind(db) as NodePgDatabase<typeof schema>["transaction"];
  const wrapped: NodePgDatabase<typeof schema>["transaction"] = (...args) =>
    instrument({
      module: "db",
      action: "transaction",
      level: "debug",
      thresholdMs: 500,
      fn: () => original(...args),
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") return wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  _db = instrumentTransactions(drizzle(getPool(), { schema }));
  return _db;
}

/**
 * Build a dedicated db client from a connection string. Used by the
 * migration runner and by the test setup which each create their own
 * disposable pool.
 */
export function createDbFromUrl(url: string): {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
} {
  const pool = new Pool({ connectionString: url, options: SUBKIT_DATABASE_OPTIONS });
  pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "pool.error",
      msg: "postgres pool emitted error",
      error: err.message,
    });
  });
  const db = instrumentTransactions(drizzle(pool, { schema }));
  return { pool, db };
}

/**
 * Build the dedicated client used while applying the historical migration
 * lineage. Those migrations intentionally create their legacy objects in
 * `public`; the final embedded migration moves the complete product-owned set
 * into `subkit`. Runtime connections use `SUBKIT_DATABASE_OPTIONS` only after
 * that transition has completed.
 */
export function createMigrationDbFromUrl(url: string): {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
} {
  // A role named `subkit` makes PostgreSQL's default `$user,public` path pick
  // the already-created `subkit` schema first. Historical migrations contain
  // explicit `public` foreign-key references, so they must reproduce their
  // original public-schema lineage before 0041 moves the complete owned set.
  const pool = new Pool({
    connectionString: url,
    max: 1,
    options: SUBKIT_MIGRATION_DATABASE_OPTIONS,
  });
  pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "migration_pool.error",
      msg: "postgres migration pool emitted error",
      error: err.message,
    });
  });
  return { pool, db: drizzle(pool, { schema }) };
}

/**
 * Dispose the shared pool. Intended for clean shutdowns and tests.
 */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    logger.debug({
      module: "db",
      action: "pool.closed",
      msg: "postgres pool closed",
    });
  }
}

export { schema };
export type Db = NodePgDatabase<typeof schema>;

/**
 * Accepts either the root `Db` or a drizzle transaction handle. Callers
 * that compose with `db.transaction(async (tx) => …)` can take this
 * type so the helper works equally well at top level and inside a tx.
 *
 * This is the single canonical definition. Subsystem modules import the
 * alias from here rather than redeclaring it locally.
 */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
