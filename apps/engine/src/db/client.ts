// Drizzle client over node-postgres. A single shared Pool plus a typed
// `db` wrapper. Pool stats and connection errors are logged under module=db.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config/loader.ts";
import { logger } from "../logging/logger.ts";
import * as schema from "./schema/index.ts";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

/**
 * Lazy pool factory — creates a connection pool the first time the db is
 * touched. Tests may call `createDbFromUrl()` directly to get an isolated
 * instance against a disposable database.
 */
export function getPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: getConfig().database.url });
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

export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema });
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
  const db = drizzle(pool, { schema });
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
