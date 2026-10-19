import pg from "pg";
import { log } from "../../logging/logger.ts";
import { scrubUrl } from "../egress.ts";
import { postgresPoolConfiguration } from "../postgres-egress.ts";
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
SELECT table_schema, table_name, column_name, data_type, is_nullable,
       column_default, ordinal_position
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position
`;

const PRIMARY_KEYS_SQL = `
SELECT kcu.table_schema, kcu.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
`;

const FOREIGN_KEYS_SQL = `
SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name   AS foreign_table_name,
       ccu.column_name  AS foreign_column_name,
       tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
`;

export function looksLikePostgresUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("postgres://") || lower.startsWith("postgresql://");
}

interface IntrospectionData {
  database: string | null;
  columns: ColumnRow[];
  primaryKeys: PrimaryKeyRow[];
  foreignKeys: ForeignKeyRow[];
}

async function fetchSchema(
  url: string,
  opts: DiscoveryStrategyOptions,
): Promise<IntrospectionData> {
  const signal = opts.signal;
  const prepared = await postgresPoolConfiguration(
    url,
    {
      ...(opts.tenant_id ? { tenant_id: opts.tenant_id } : {}),
      ...(opts.exec ? { exec: opts.exec } : {}),
    },
    {
      max: 1,
      connectionTimeoutMillis: DEFAULT_TIMEOUT_MS,
      statement_timeout: DEFAULT_TIMEOUT_MS,
    },
  );
  const pool = new pg.Pool(prepared.options);
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
      pool.query<{ current_database: string }>("SELECT current_database()"),
      aborted,
    ]);
    const cols = await Promise.race([pool.query<ColumnRow>(COLUMNS_SQL), aborted]);
    const pks = await Promise.race([pool.query<PrimaryKeyRow>(PRIMARY_KEYS_SQL), aborted]);
    const fks = await Promise.race([pool.query<ForeignKeyRow>(FOREIGN_KEYS_SQL), aborted]);
    return {
      database: dbRow.rows[0]?.current_database ?? null,
      columns: cols.rows,
      primaryKeys: pks.rows,
      foreignKeys: fks.rows,
    };
  } finally {
    pool.end().catch(() => {});
  }
}

export function renderSchemaMarkdown(
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

class PostgresIntrospectStrategy implements DiscoveryStrategy {
  readonly name = "postgres-introspect" as const;

  canHandle(url: string): boolean {
    return looksLikePostgresUrl(url);
  }

  async fetch(url: string, opts: DiscoveryStrategyOptions): Promise<DiscoveryResult> {
    log.debug({
      module: "connector",
      action: "discovery.strategy.started",
      strategy: this.name,
      url: scrubUrl(url),
    });
    try {
      const data = await fetchSchema(url, opts);
      const markdown = renderSchemaMarkdown(data);
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
      log.debug({
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

export const postgresIntrospectStrategy: DiscoveryStrategy = new PostgresIntrospectStrategy();
