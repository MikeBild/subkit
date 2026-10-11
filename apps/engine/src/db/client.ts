import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config/loader.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import * as schema from "./schema/index.ts";

const { Pool } = pg;
export const EXPECTED_SCHEMA = "subkit";

export const MIGRATION_SEARCH_PATH_SQL = "SET LOCAL search_path = public, pg_catalog";
export const ISOLATION_MIGRATION_TAG = "0041_isolated_schema";

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

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
  _pool = new Pool({ connectionString: url });
  _pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "pool.error",
      msg: "postgres pool emitted error",
      ...errorFields(err),
    });
  });
  logger.debug({
    module: "db",
    action: "pool.created",
    msg: "postgres pool created",
  });
  return _pool;
}

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
      ...errorFields(err),
    });
  });
  const db = instrumentTransactions(drizzle(pool, { schema }));
  return { pool, db };
}

export function createMigrationDbFromUrl(url: string): {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
} {
  const pool = new Pool({
    connectionString: url,
    max: 1,
  });
  pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "migration_pool.error",
      msg: "postgres migration pool emitted error",
      ...errorFields(err),
    });
  });
  return { pool, db: drizzle(pool, { schema }) };
}

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

export type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function assertSearchPath(pool: {
  query: (sql: string) => Promise<{ rows: Array<{ schema: string | null }> }>;
}): Promise<void> {
  const result = await pool.query("SELECT current_schema() AS schema");
  const schema = result.rows[0]?.schema ?? null;
  if (schema === EXPECTED_SCHEMA) return;
  throw new Error(
    `database search_path resolves to ${schema ?? "no schema"} instead of ${EXPECTED_SCHEMA}. ` +
      `Set it on the role: ALTER ROLE <role> SET search_path = ${EXPECTED_SCHEMA}, pg_catalog, public;`,
  );
}
