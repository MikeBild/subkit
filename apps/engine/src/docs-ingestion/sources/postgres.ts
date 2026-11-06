import pg from "pg";
import { postgresPoolConfiguration } from "../../connectors/index.ts";
import type { Executor } from "../../db/client.ts";
import { consumeBytes } from "../budgets.ts";
import { byteLen } from "../chunker.ts";
import type { BudgetState, RawChunk } from "../types.ts";

const { Pool } = pg;

interface PostgresIngestParams {
  exec?: Executor;
  tenant_id?: string;
  dsn: string;
  schemas?: string[];
}

interface PostgresIngestResult {
  uri: string;
  raw_bytes: number;
  chunks: RawChunk[];
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

interface FkRow {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

function chunkPostgresInformationSchema(columns: ColumnRow[], foreignKeys: FkRow[]): RawChunk[] {
  const tables = new Map<string, ColumnRow[]>();
  for (const c of columns) {
    const key = `${c.table_schema}.${c.table_name}`;
    const list = tables.get(key) ?? [];
    list.push(c);
    tables.set(key, list);
  }
  const fkByTable = new Map<string, FkRow[]>();
  for (const fk of foreignKeys) {
    const key = `${fk.table_schema}.${fk.table_name}`;
    const list = fkByTable.get(key) ?? [];
    list.push(fk);
    fkByTable.set(key, list);
  }

  const out: RawChunk[] = [];
  for (const [tableKey, cols] of tables) {
    cols.sort((a, b) => a.ordinal_position - b.ordinal_position);
    const fks = fkByTable.get(tableKey) ?? [];
    const colLines = cols.map(
      (c) =>
        `- ${c.column_name}: ${c.data_type}` +
        (c.is_nullable === "NO" ? " NOT NULL" : "") +
        (c.column_default ? ` DEFAULT ${c.column_default}` : ""),
    );
    const fkLines = fks.map(
      (fk) =>
        `- ${fk.column_name} -> ${fk.foreign_table_schema}.${fk.foreign_table_name}.${fk.foreign_column_name}`,
    );
    const body = [
      `# table ${tableKey}`,
      "## columns",
      colLines.join("\n"),
      fkLines.length > 0 ? `\n## foreign keys\n${fkLines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    out.push({
      title: `table: ${tableKey}`,
      path: `tables.${tableKey}`,
      content: body,
    });
  }
  return out;
}

export async function ingestPostgresInformationSchema(
  p: PostgresIngestParams,
  state: BudgetState,
): Promise<PostgresIngestResult> {
  const prepared = await postgresPoolConfiguration(
    p.dsn,
    {
      ...(p.tenant_id ? { tenant_id: p.tenant_id } : {}),
      ...(p.exec ? { exec: p.exec } : {}),
    },
    { max: 2 },
  );
  const schemas = p.schemas && p.schemas.length > 0 ? p.schemas : ["public"];
  const pool = new Pool(prepared.options);
  try {
    const colsRes = await pool.query<ColumnRow>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = ANY($1::text[])
       ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );
    const fkRes = await pool.query<FkRow>(
      `SELECT
         tc.constraint_name,
         tc.table_schema,
         tc.table_name,
         kcu.column_name,
         ccu.table_schema AS foreign_table_schema,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = ANY($1::text[])`,
      [schemas],
    );
    const chunks = chunkPostgresInformationSchema(colsRes.rows, fkRes.rows);
    let bytes = 0;
    for (const c of chunks) bytes += byteLen(c.content);
    consumeBytes(state, bytes);
    return {
      uri: `postgres://${schemas.join(",")}`,
      raw_bytes: bytes,
      chunks,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}
