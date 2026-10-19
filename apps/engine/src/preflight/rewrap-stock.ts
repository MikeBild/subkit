import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  VAULT_STOCK_INVENTORY,
  VAULT_STOCK_TABLES,
  vaultStockColumnPredicate,
} from "../db/vault-stock-sql.ts";

export class RegistryRewrapScopeError extends Error {
  readonly code = "vault_non_registry_stock_unsupported";
  constructor() {
    super(
      "Settings-only rewrap cannot preserve retained non-registry encrypted data or keyed proofs. Keep the current MASTER_KEY; whole-stock rotation is not supported.",
    );
    this.name = "RegistryRewrapScopeError";
  }
}

export async function assertRegistryRewrapScope(db: Executor): Promise<void> {
  const metadata = await db.execute<{
    table_name: string;
    relation_kind: string;
    column_name: string | null;
    json_compatible: boolean;
  }>(sql`
    SELECT c.relname AS table_name,c.relkind AS relation_kind,a.attname AS column_name,
      COALESCE(a.atttypid='pg_catalog.jsonb'::regtype,false) AS json_compatible
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='subkit' AND c.relname IN (${sql.join(
      VAULT_STOCK_TABLES.map((table) => sql`${table}`),
      sql`, `,
    )})
  `);
  const tables = new Map<string, Map<string, boolean>>();
  for (const row of metadata.rows) {
    if (row.relation_kind !== "r" && row.relation_kind !== "p")
      throw new RegistryRewrapScopeError();
    const columns = tables.get(row.table_name) ?? new Map<string, boolean>();
    if (row.column_name !== null) columns.set(row.column_name, row.json_compatible);
    tables.set(row.table_name, columns);
  }
  const present = VAULT_STOCK_TABLES.filter((table) => tables.has(table));
  if (present.length > 0) {
    await db.execute(
      sql.raw(`LOCK TABLE ${present.map((table) => `subkit."${table}"`).join(",")} IN SHARE MODE`),
    );
  }
  for (const stock of VAULT_STOCK_INVENTORY) {
    const columns = tables.get(stock.table);
    if (!columns) continue;
    const predicates = stock.columns
      .filter((column) => columns.has(column.name))
      .map((column) => vaultStockColumnPredicate(column, columns.get(column.name)));
    if (predicates.length === 0) continue;
    const result = await db.execute<{ present: boolean }>(
      sql.raw(
        `SELECT EXISTS(SELECT 1 FROM subkit."${stock.table}" stock WHERE ${predicates.join(" OR ")}) AS present`,
      ),
    );
    if (result.rows[0]?.present !== false) throw new RegistryRewrapScopeError();
  }
}
