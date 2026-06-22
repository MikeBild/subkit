// MSSQL driver. Thin wrapper around the `mssql` package. The DSN is
// parsed into a ConnectionPool config.
//
// DSN shape: mssql://user:pass@host[:port]/database?encrypt=true&trustServerCertificate=false
//
// Commands exposed:
//   query(sql, params)  → rows[]
//
// Pool lifecycle: one ConnectionPool per (connector_id, environment).
// Tests call `closeAllMssqlPools()` to reset.

import mssql from "mssql";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import type { ConnectorView } from "../types.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyMssqlProbeError } from "./probe-classify.ts";

const pools = new Map<string, mssql.ConnectionPool>();

function poolKey(connector: ConnectorView): string {
  return `${connector.id}:${connector.environment}`;
}

function parseDsn(dsn: string): mssql.config {
  const url = new URL(dsn);
  if (url.protocol !== "mssql:" && url.protocol !== "sqlserver:") {
    throw new Error(`mssql dsn must use mssql:// or sqlserver:// scheme, got ${url.protocol}`);
  }
  const database = url.pathname.replace(/^\//, "") || undefined;
  const port = url.port ? Number(url.port) : 1433;
  const encrypt = url.searchParams.get("encrypt") !== "false";
  const trust = url.searchParams.get("trustServerCertificate") === "true";
  const config: mssql.config = {
    server: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database ? { database } : {}),
    options: {
      encrypt,
      trustServerCertificate: trust,
    },
  };
  return config;
}

async function getPool(connector: ConnectorView): Promise<mssql.ConnectionPool> {
  if (!connector.dsn) {
    throw new Error(`MSSQL connector ${connector.id} has no dsn; cannot open pool`);
  }
  const key = poolKey(connector);
  const existing = pools.get(key);
  if (existing?.connected) return existing;
  const pool = new mssql.ConnectionPool(parseDsn(connector.dsn));
  pool.on("error", (err: Error) => {
    logger.error({
      module: "connectors",
      action: "mssql.pool.error",
      msg: "mssql driver pool emitted error",
      connector_id: connector.id,
      ...errorFields(err),
    });
  });
  await pool.connect();
  pools.set(key, pool);
  return pool;
}

export async function probeMssqlConnector(connector: ConnectorView): Promise<DriverProbeResult> {
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
    const pool = await getPool(connector);
    const res = await pool.request().query("SELECT 1 AS ok");
    return {
      ok: res.recordset[0]?.ok === 1,
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      error_code: classifyMssqlProbeError(err),
    };
  }
}

export interface MssqlQueryParams {
  connector: ConnectorView;
  sql: string;
  /**
   * Parameterised inputs. Keys become @name placeholders — call sites
   * should use @name in the SQL string (mssql's native binding).
   */
  params?: Record<string, string | number | boolean | null | Date>;
}

export async function mssqlQuery<T = Record<string, unknown>>(p: MssqlQueryParams): Promise<T[]> {
  const pool = await getPool(p.connector);
  const req = pool.request();
  for (const [name, value] of Object.entries(p.params ?? {})) {
    req.input(name, value);
  }
  const res = await instrument({
    module: "connector",
    action: "driver.mssql.request",
    level: "debug",
    thresholdMs: 1000,
    fields: { connector_id: p.connector.id, op: "query" },
    fn: () => req.query(p.sql),
  });
  return res.recordset as T[];
}

export async function closeAllMssqlPools(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.close().catch(() => {})));
}
