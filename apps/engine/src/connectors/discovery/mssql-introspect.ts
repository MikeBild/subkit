// Strategy: Microsoft SQL Server schema introspection.
//
// Mirrors `postgres-introspect.ts` for SQL Server / Azure SQL.
// Accepts `mssql://` or `sqlserver://` URLs, opens a short-lived
// connection, queries `INFORMATION_SCHEMA.COLUMNS` and the SQL Server
// `sys.foreign_keys` catalog, and emits a Markdown corpus the LLM can
// read before authoring SQL.

import mssql from "mssql";
import { log } from "../../logging/logger.ts";
import { scrubUrl } from "../egress.ts";
import {
  DiscoveryError,
  type DiscoveryResult,
  type DiscoveryStrategy,
  type DiscoveryStrategyOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TABLES_DEFAULT = 200;

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  ordinal_position: number;
}

interface PrimaryKeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface ForeignKeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
  constraint_name: string;
}

const COLUMNS_SQL = `
SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
       COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
       IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
       ORDINAL_POSITION AS ordinal_position
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
`;

const PRIMARY_KEYS_SQL = `
SELECT kcu.TABLE_SCHEMA AS table_schema, kcu.TABLE_NAME AS table_name,
       kcu.COLUMN_NAME AS column_name
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
 AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  AND tc.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
`;

const FOREIGN_KEYS_SQL = `
SELECT
  SCHEMA_NAME(fk.schema_id)  AS table_schema,
  OBJECT_NAME(fkc.parent_object_id) AS table_name,
  cp.name AS column_name,
  SCHEMA_NAME(rt.schema_id) AS foreign_table_schema,
  OBJECT_NAME(fkc.referenced_object_id) AS foreign_table_name,
  cr.name AS foreign_column_name,
  fk.name AS constraint_name
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.columns cp
  ON cp.object_id = fkc.parent_object_id
 AND cp.column_id = fkc.parent_column_id
JOIN sys.columns cr
  ON cr.object_id = fkc.referenced_object_id
 AND cr.column_id = fkc.referenced_column_id
`;

/** True for `mssql://` / `sqlserver://` URIs. */
export function looksLikeMssqlUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("mssql://") || lower.startsWith("sqlserver://");
}

interface IntrospectionData {
  database: string | null;
  columns: ColumnRow[];
  primaryKeys: PrimaryKeyRow[];
  foreignKeys: ForeignKeyRow[];
}

function parseMssqlUrl(rawUrl: string): mssql.config {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "") || undefined;
  const port = url.port ? Number(url.port) : 1433;
  const encrypt = url.searchParams.get("encrypt") !== "false";
  const trust = url.searchParams.get("trustServerCertificate") === "true";
  return {
    server: url.hostname,
    port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database ? { database } : {}),
    options: {
      encrypt,
      trustServerCertificate: trust,
    },
    connectionTimeout: DEFAULT_TIMEOUT_MS,
    requestTimeout: DEFAULT_TIMEOUT_MS,
  };
}

async function fetchSchema(url: string, signal?: AbortSignal): Promise<IntrospectionData> {
  const config = parseMssqlUrl(url);
  const pool = await new mssql.ConnectionPool(config).connect();
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new DiscoveryError("aborted", "discovery aborted"));
    signal.addEventListener(
      "abort",
      () => reject(new DiscoveryError("aborted", "discovery aborted")),
      { once: true },
    );
  });
  try {
    const dbRow = await Promise.race([
      pool.request().query<{ db: string }>("SELECT DB_NAME() AS db"),
      aborted,
    ]);
    const cols = await Promise.race([pool.request().query<ColumnRow>(COLUMNS_SQL), aborted]);
    const pks = await Promise.race([
      pool.request().query<PrimaryKeyRow>(PRIMARY_KEYS_SQL),
      aborted,
    ]);
    const fks = await Promise.race([
      pool.request().query<ForeignKeyRow>(FOREIGN_KEYS_SQL),
      aborted,
    ]);
    return {
      database: dbRow.recordset[0]?.db ?? null,
      columns: cols.recordset,
      primaryKeys: pks.recordset,
      foreignKeys: fks.recordset,
    };
  } finally {
    pool.close().catch(() => {});
  }
}

/** Render the catalog rows as a Markdown corpus. Same shape as the
 *  postgres-introspect strategy so downstream consumers don't need to
 *  branch on driver. */
export function renderMssqlSchemaMarkdown(
  data: IntrospectionData,
  opts: { maxTables?: number } = {},
): string {
  const maxTables = opts.maxTables ?? MAX_TABLES_DEFAULT;
  const byTable = new Map<string, ColumnRow[]>();
  for (const c of data.columns) {
    const key = `${c.table_schema}.${c.table_name}`;
    const list = byTable.get(key) ?? [];
    list.push(c);
    byTable.set(key, list);
  }
  const pkSet = new Set<string>();
  for (const p of data.primaryKeys) {
    pkSet.add(`${p.table_schema}.${p.table_name}.${p.column_name}`);
  }
  const fksByTable = new Map<string, ForeignKeyRow[]>();
  for (const f of data.foreignKeys) {
    const key = `${f.table_schema}.${f.table_name}`;
    const list = fksByTable.get(key) ?? [];
    list.push(f);
    fksByTable.set(key, list);
  }

  const tables = [...byTable.keys()].sort();
  const truncated = tables.length > maxTables;
  const shown = tables.slice(0, maxTables);

  const out: string[] = [];
  out.push(`# Database schema: ${data.database ?? "(unknown)"}`);
  out.push("");
  out.push(`_${tables.length} tables across ${countSchemas(tables)} schema(s)._`);
  if (truncated) {
    out.push("");
    out.push(`> Truncated — only first ${maxTables} tables shown.`);
  }
  out.push("");

  for (const tableKey of shown) {
    const cols = byTable.get(tableKey) ?? [];
    out.push(`## ${tableKey}`);
    out.push("");
    out.push("| column | type | nullable | default | pk |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const c of cols) {
      const pk = pkSet.has(`${c.table_schema}.${c.table_name}.${c.column_name}`) ? "PK" : "";
      const def = c.column_default ?? "";
      out.push(
        `| ${c.column_name} | ${c.data_type} | ${c.is_nullable} | ${escapeCell(def)} | ${pk} |`,
      );
    }
    const fks = fksByTable.get(tableKey) ?? [];
    if (fks.length > 0) {
      out.push("");
      out.push("**Foreign keys:**");
      for (const f of fks) {
        out.push(
          `- \`${f.column_name}\` → \`${f.foreign_table_schema}.${f.foreign_table_name}.${f.foreign_column_name}\``,
        );
      }
    }
    out.push("");
  }
  return out.join("\n");
}

function countSchemas(tables: string[]): number {
  const set = new Set<string>();
  for (const t of tables) set.add(t.split(".")[0] ?? "");
  return set.size;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

class MssqlIntrospectStrategy implements DiscoveryStrategy {
  readonly name = "mssql-introspect" as const;

  canHandle(url: string): boolean {
    return looksLikeMssqlUrl(url);
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });
    try {
      const data = await fetchSchema(url, opts.signal);
      const markdown = renderMssqlSchemaMarkdown(data);
      log.info({
        module: "connector",
        action: "discovery.strategy.succeeded",
        strategy: this.name,
        url: scrubUrl(url),
        endpoints: 0,
        tables: new Set(data.columns.map((c) => `${c.table_schema}.${c.table_name}`)).size,
        corpus_bytes: markdown.length,
      });
      return {
        source_url: url,
        fetched_at: new Date().toISOString(),
        strategy: this.name,
        spec_version: null,
        title: data.database,
        servers: [url],
        auth_schemes: [],
        endpoints: [],
        warnings: [],
        text_corpus: markdown,
      };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "fetch_failed";
      const message = err instanceof Error ? err.message : String(err);
      log.warn({
        module: "connector",
        action: "discovery.strategy.failed",
        strategy: this.name,
        url: scrubUrl(url),
        code,
        message,
      });
      if (err instanceof DiscoveryError) throw err;
      throw new DiscoveryError(code, message);
    }
  }
}

export const mssqlIntrospectStrategy: DiscoveryStrategy = new MssqlIntrospectStrategy();
