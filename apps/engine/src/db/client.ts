// Drizzle client over node-postgres. A single shared Pool plus a typed
// `db` wrapper. Pool stats and connection errors are logged under module=db.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import * as schema from "./schema/index.ts";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

/**
 * Lazy pool factory — creates a connection pool the first time the db is
 * touched. Tests may call `createDbFromUrl()` directly to get an isolated
 * instance against a disposable database.
 *
 * URL resolution order:
 *   1. `process.env.DATABASE_URL` if set — wins over the loaded config.
 *      Tests set this explicitly (e.g. `self-update.test.ts` boots its
 *      own per-suite Postgres and pins env DB_URL to it); a sibling
 *      test that called `loadConfig({env:{DATABASE_URL:"placeholder/x"}})`
 *      to satisfy `getConfig().storage` would otherwise force this pool
 *      to dial `placeholder/x` and fail DNS under concurrency.
 *   2. `getConfig().database.url` — the production path. The engine
 *      boots with `loadConfig()` reading `process.env.DATABASE_URL`,
 *      so in production both paths agree.
 *   3. Empty → throw a helpful error.
 */
export function getPool(): pg.Pool {
  if (_pool) return _pool;
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    try {
      url = getConfig().database.url;
    } catch {
      url = "";
    }
  }
  if (!url) {
    throw new Error(
      "database.url is not set. Configure via `sk settings set database.url '\"…\"'` or set DATABASE_URL.",
    );
  }
  _pool = new Pool({ connectionString: url });
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
  const pool = new Pool({ connectionString: url });
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
 * Several subsystem modules redeclare this alias locally (see
 * `workflows/service.ts`, `llm/core/context-assembler/loaders.ts`, …);
 * those are left in place to keep this PR narrow. New modules should
 * import the alias from here instead.
 */
export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
