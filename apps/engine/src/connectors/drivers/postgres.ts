import pg from "pg";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyPgProbeError } from "./probe-classify.ts";

const { Pool } = pg;

const pools = new Map<string, pg.Pool>();

function poolKey(connector: ConnectorView): string {
  return `${connector.id}:${connector.environment}`;
}

export function getPoolForConnector(connector: ConnectorView): pg.Pool {
  if (!connector.dsn) {
    throw new Error(`Postgres connector ${connector.id} has no dsn; cannot open pool`);
  }
  const key = poolKey(connector);
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = new Pool({ connectionString: connector.dsn, max: 5 });
  pool.on("error", (err) => {
    logger.error({
      module: "connectors",
      action: "pg.pool.error",
      msg: "postgres driver pool emitted error",
      connector_id: connector.id,
      ...errorFields(err),
    });
  });
  pools.set(key, pool);
  return pool;
}

export async function probePgConnector(connector: ConnectorView): Promise<DriverProbeResult> {
  const start = Date.now();
  if (!connector.dsn) {
    return {
      ok: false,
      latency_ms: 0,
      detail: "connector has no dsn",
      error_code: "credential_missing",
    };
  }
  try {
    const pool = getPoolForConnector(connector);
    const res = await pool.query("SELECT 1 as ok");
    return {
      ok: res.rows[0]?.ok === 1,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      error_code: classifyPgProbeError(err),
    };
  }
}

export interface PgQueryParams {
  on_credential_use?: () => Promise<void>;
  connector: ConnectorView;
  sql: string;
  params?: unknown[];
}

export interface PgQueryResult<T = unknown> {
  rows: T[];
  row_count: number | null;
}

export async function pgQueryWithCount<T = unknown>(p: PgQueryParams): Promise<PgQueryResult<T>> {
  const pool = getPoolForConnector(p.connector);
  const res = await instrument({
    module: "connector",
    action: "driver.postgres.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { connector_id: p.connector.id, op: "query" },
    fn: async () => {
      const client = await pool.connect();
      try {
        await p.on_credential_use?.();
        return await client.query(p.sql, p.params ?? []);
      } finally {
        client.release();
      }
    },
  });
  return {
    rows: res.rows as T[],
    row_count: typeof res.rowCount === "number" ? res.rowCount : null,
  };
}

export interface PgTransactionStatement {
  query: string;
  params?: unknown[];
}

export async function pgTransaction<T = unknown>(p: {
  on_credential_use?: () => Promise<void>;
  connector: ConnectorView;
  statements: PgTransactionStatement[];
  onStatement?: (index: number, rows: T[], rowCount: number | null) => void | Promise<void>;
}): Promise<{
  rows_per_statement: T[][];
  row_count_per_statement: Array<number | null>;
  total_row_count: number;
}> {
  const pool = getPoolForConnector(p.connector);
  const client = await pool.connect();
  try {
    return await instrument({
      module: "connector",
      action: "driver.postgres.request",
      level: "debug",
      thresholdMs: 1000,
      fields: {
        connector_id: p.connector.id,
        op: "transaction",
        statement_count: p.statements.length,
      },
      fn: async () => {
        await p.on_credential_use?.();
        await client.query("BEGIN");
        const out: T[][] = [];
        const counts: Array<number | null> = [];
        let total = 0;
        for (let i = 0; i < p.statements.length; i++) {
          const stmt = p.statements[i]!;
          const res = await client.query(stmt.query, stmt.params ?? []);
          out.push(res.rows as T[]);
          const rc = typeof res.rowCount === "number" ? res.rowCount : null;
          counts.push(rc);
          if (rc !== null) total += rc;
          if (p.onStatement) await p.onStatement(i, res.rows as T[], rc);
        }
        await client.query("COMMIT");
        return {
          rows_per_statement: out,
          row_count_per_statement: counts,
          total_row_count: total,
        };
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function pgQueryCursor<T = unknown>(p: {
  on_credential_use?: () => Promise<void>;
  connector: ConnectorView;
  sql: string;
  params?: unknown[];
  fetch_size: number;
}): Promise<T[]> {
  const pool = getPoolForConnector(p.connector);
  const client = await pool.connect();
  const cursorName = `sk_cursor_${Math.random().toString(36).slice(2, 10)}`;
  try {
    return await instrument({
      module: "connector",
      action: "driver.postgres.request",
      level: "debug",
      thresholdMs: 1000,
      fields: { connector_id: p.connector.id, op: "cursor", fetch_size: p.fetch_size },
      fn: async () => {
        await p.on_credential_use?.();
        await client.query("BEGIN");
        await client.query(`DECLARE ${cursorName} CURSOR FOR ${p.sql}`, p.params ?? []);
        const out: T[] = [];
        while (true) {
          const batch = await client.query(`FETCH ${p.fetch_size} FROM ${cursorName}`);
          if (batch.rows.length === 0) break;
          for (const row of batch.rows as T[]) out.push(row);
          if (batch.rows.length < p.fetch_size) break;
        }
        await client.query(`CLOSE ${cursorName}`);
        await client.query("COMMIT");
        return out;
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function closePoolForConnector(connector: ConnectorView): Promise<void> {
  const key = poolKey(connector);
  const pool = pools.get(key);
  if (!pool) return;
  pools.delete(key);
  try {
    await pool.end();
  } catch {}
}

export async function closeAllPools(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}
