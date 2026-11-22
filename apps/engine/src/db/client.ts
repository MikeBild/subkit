import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getConfig } from "../config/loader.ts";
import { readEnv } from "../env.ts";
import { withContext } from "../logging/context.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  beginDiagnosticTransaction,
  diagnoseOperation,
  diagnoseQuery,
  endDiagnosticTransaction,
  runtimeDiagnosticsEnabled,
} from "../observability/runtime-diagnostics.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { databasePoolOptions } from "./connection-options.ts";
import { hostedQuotaError } from "./hosted-quota-errors.ts";
import * as schema from "./schema/index.ts";

const { Pool } = pg;
export const EXPECTED_SCHEMA = "subkit";

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

const diagnosticPools = new WeakSet<pg.Pool>();

function instrumentPoolDiagnostics(pool: pg.Pool): void {
  if (!runtimeDiagnosticsEnabled() || diagnosticPools.has(pool)) return;
  diagnosticPools.add(pool);
  const poolCounts = () => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options.max,
  });
  pool.on("connect", (client) => {
    const rawClient = client as unknown as {
      processID?: number;
      query: (...args: unknown[]) => unknown;
    };
    const original = rawClient.query.bind(rawClient);
    client.query = ((...args: unknown[]) => {
      if (typeof args.at(-1) === "function") return original(...args);
      return diagnoseQuery({
        action: "db.query",
        ...(typeof rawClient.processID === "number" ? { backend_pid: rawClient.processID } : {}),
        pool: "app",
        poolCounts,
        fn: async () => await original(...args),
      });
    }) as typeof client.query;
  });
  const originalConnect = pool.connect.bind(pool);
  pool.connect = ((...args: unknown[]) => {
    if (typeof args.at(-1) === "function") return originalConnect(...(args as []));
    return diagnoseOperation({
      action: "db.pool.checkout",
      pool: "app",
      poolCounts,
      fn: async () => await originalConnect(...(args as [])),
    });
  }) as typeof pool.connect;
}

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  let url = "";
  if (readEnv("NODE_ENV") === "test") url = readEnv("DATABASE_URL") ?? "";
  if (!url) {
    try {
      url = getConfig().database.url;
    } catch {
      url = "";
    }
  }
  if (!url) url = readEnv("DATABASE_URL") ?? "";
  if (!url) {
    throw new Error(
      "database.url is not set. Configure via `subkit settings set database.url '\"…\"'` or set DATABASE_URL.",
    );
  }
  _pool = new Pool(databasePoolOptions(url));
  instrumentPoolDiagnostics(_pool);
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

export async function readAdvisoryLockSnapshot(
  pool: Pick<pg.Pool, "connect"> = getPool(),
): Promise<{ waiters: Array<{ waiter_backend_pid: number; blocker_backend_pids: number[] }> }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '100ms'");
    const result = await client.query(
      "SELECT pid, pg_blocking_pids(pid) AS blocker_backend_pids FROM pg_locks WHERE locktype = 'advisory' AND NOT granted ORDER BY pid LIMIT 50",
    );
    await client.query("COMMIT");
    const waiters = result.rows.flatMap((row) => {
      const pid = Number((row as { pid?: unknown }).pid);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const raw = (row as { blocker_backend_pids?: unknown }).blocker_backend_pids;
      const blockers = Array.isArray(raw)
        ? raw.map(Number).filter((candidate) => Number.isInteger(candidate) && candidate > 0)
        : [];
      return [{ waiter_backend_pid: pid, blocker_backend_pids: blockers }];
    });
    return { waiters };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function instrumentTransactions(
  db: NodePgDatabase<typeof schema>,
  pool: Pick<pg.Pool, "totalCount" | "idleCount" | "waitingCount" | "options">,
): NodePgDatabase<typeof schema> {
  const original = db.transaction.bind(db) as NodePgDatabase<typeof schema>["transaction"];
  const wrapped: NodePgDatabase<typeof schema>["transaction"] = (...args) => {
    const txId = beginDiagnosticTransaction();
    const invoke = () =>
      original(...args).catch((error: unknown) => {
        throw hostedQuotaError(error) ?? error;
      });
    const observed = () =>
      diagnoseOperation({
        action: "db.transaction",
        pool: "app",
        poolCounts: () => ({
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: pool.options.max,
        }),
        fn: () =>
          instrument({
            module: "db",
            action: "transaction",
            level: "debug",
            thresholdMs: 500,
            fn: invoke,
          }),
      }).finally(() => endDiagnosticTransaction(txId));
    return txId ? withContext({ db_tx_id: txId }, observed) : observed();
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") return wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  const pool = getPool();
  _db = instrumentTransactions(drizzle(pool, { schema }), pool);
  return _db;
}

export function createDbFromUrl(url: string): {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
} {
  const pool = new Pool(databasePoolOptions(url));
  instrumentPoolDiagnostics(pool);
  pool.on("error", (err) => {
    logger.error({
      module: "db",
      action: "pool.error",
      msg: "postgres pool emitted error",
      ...errorFields(err),
    });
  });
  const db = instrumentTransactions(drizzle(pool, { schema }), pool);
  return { pool, db };
}

export function createMigrationDbFromUrl(url: string): {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
} {
  const pool = new Pool(databasePoolOptions(url, undefined, true));
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

export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Transaction;

export async function assertSearchPath(pool: {
  query: (sql: string) => Promise<{ rows: Array<{ schema: string | null }> }>;
}): Promise<void> {
  const result = await pool.query("SELECT current_schema() AS schema");
  const schema = result.rows[0]?.schema ?? null;
  if (schema === EXPECTED_SCHEMA) return;
  throw new Error(
    `database search_path resolves to ${schema ?? "no schema"} instead of ${EXPECTED_SCHEMA}. ` +
      `The engine sets search_path on every connection, so check that schema ${EXPECTED_SCHEMA} exists and the database role may use it.`,
  );
}
