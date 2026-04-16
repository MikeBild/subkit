// Postgres driver. Holds a per-connector lazy pg Pool and exposes a
// minimal `query` helper + a `probe` for the connectors/test endpoint.
//
// Pool lifecycle: one pool per connector id. The map lives at module
// scope so repeated calls share the same client. Tests can call
// `closeAllPools()` to reset.

import pg from "pg";
import { logger } from "../../logging/logger.ts";
import type { ConnectorView } from "../types.ts";

const { Pool } = pg;

const pools = new Map<string, pg.Pool>();

function poolKey(connector: ConnectorView): string {
  return `${connector.id}:${connector.environment}`;
}

/**
 * Resolve a connection pool for a connector. The connector's `dsn` is
 * required; if it's missing the function throws so the caller can
 * surface a 400.
 */
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
      error: err.message,
    });
  });
  pools.set(key, pool);
  return pool;
}

export async function probePgConnector(
  connector: ConnectorView,
): Promise<{ ok: boolean; latency_ms: number; detail?: string }> {
  const start = Date.now();
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
    };
  }
}

export interface PgQueryParams {
  connector: ConnectorView;
  sql: string;
  params?: unknown[];
}

export async function pgQuery<T = unknown>(p: PgQueryParams): Promise<T[]> {
  const pool = getPoolForConnector(p.connector);
  const res = await pool.query(p.sql, p.params ?? []);
  return res.rows as T[];
}

/**
 * Close every cached pool. Tests and shutdown hooks call this.
 */
export async function closeAllPools(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}
