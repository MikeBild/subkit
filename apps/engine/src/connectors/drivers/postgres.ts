import pg from "pg";
import type { Executor } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { EgressGuardContext } from "../egress-guard.ts";
import {
  assertPostgresDsnEgress,
  postgresDsnTarget,
  postgresPoolConfiguration,
} from "../postgres-egress.ts";

export { assertPostgresDsnEgress } from "../postgres-egress.ts";

import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyPgProbeError } from "./probe-classify.ts";

const { Pool } = pg;

const pools = new Map<string, pg.Pool>();

function poolKey(connector: ConnectorView): string {
  return `${connector.id}:${connector.environment}`;
}

export function postgresConnectorTarget(connector: Pick<ConnectorView, "id" | "dsn">): URL {
  if (!connector.dsn) {
    throw new Error(`Postgres connector ${connector.id} has no dsn; cannot open pool`);
  }
  return postgresDsnTarget(connector.dsn);
}

export async function assertPostgresConnectorEgress(
  connector: ConnectorView,
  context: EgressGuardContext = { tenant_id: connector.tenant_id },
): Promise<void> {
  if (!connector.dsn) throw new Error("Postgres connector has no dsn");
  await assertPostgresDsnEgress(connector.dsn, context);
}

export async function getPoolForConnector(
  connector: ConnectorView,
  exec?: Executor,
): Promise<pg.Pool> {
  if (!connector.dsn) {
    throw new Error(`Postgres connector ${connector.id} has no dsn; cannot open pool`);
  }
  const prepared = await postgresPoolConfiguration(
    connector.dsn,
    { tenant_id: connector.tenant_id, ...(exec ? { exec } : {}) },
    { max: 5 },
  );
  const key = `${poolKey(connector)}:${connector.tenant_id}:${prepared.key}`;
  const existing = pools.get(key);
  if (existing) return existing;
  const prefix = `${poolKey(connector)}:${connector.tenant_id}:`;
  for (const [previousKey, previousPool] of pools) {
    if (!previousKey.startsWith(prefix)) continue;
    pools.delete(previousKey);
    void previousPool.end().catch(() => {});
  }
  const pool = new Pool(prepared.options);
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

export async function probePgConnector(
  connector: ConnectorView,
  exec?: Executor,
): Promise<DriverProbeResult> {
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
    await assertPostgresConnectorEgress(connector, {
      tenant_id: connector.tenant_id,
      ...(exec ? { exec } : {}),
    });
    const pool = await getPoolForConnector(connector, exec);
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
  exec?: Executor;
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
  await assertPostgresConnectorEgress(p.connector, {
    tenant_id: p.connector.tenant_id,
    ...(p.exec ? { exec: p.exec } : {}),
  });
  const pool = await getPoolForConnector(p.connector, p.exec);
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
  exec?: Executor;
  on_credential_use?: () => Promise<void>;
  connector: ConnectorView;
  statements: PgTransactionStatement[];
  onStatement?: (index: number, rows: T[], rowCount: number | null) => void | Promise<void>;
}): Promise<{
  rows_per_statement: T[][];
  row_count_per_statement: Array<number | null>;
  total_row_count: number;
}> {
  await assertPostgresConnectorEgress(p.connector, {
    tenant_id: p.connector.tenant_id,
    ...(p.exec ? { exec: p.exec } : {}),
  });
  const pool = await getPoolForConnector(p.connector, p.exec);
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
  exec?: Executor;
  on_credential_use?: () => Promise<void>;
  connector: ConnectorView;
  sql: string;
  params?: unknown[];
  fetch_size: number;
}): Promise<T[]> {
  await assertPostgresConnectorEgress(p.connector, {
    tenant_id: p.connector.tenant_id,
    ...(p.exec ? { exec: p.exec } : {}),
  });
  const pool = await getPoolForConnector(p.connector, p.exec);
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
  const prefix = `${poolKey(connector)}:${connector.tenant_id}:`;
  const closing = [...pools].filter(([key]) => key.startsWith(prefix));
  for (const [key] of closing) pools.delete(key);
  await Promise.all(closing.map(([, pool]) => pool.end().catch(() => {})));
}

export async function closeAllPools(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}
