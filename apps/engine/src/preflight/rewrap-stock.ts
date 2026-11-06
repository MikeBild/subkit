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
  await db.execute(
    sql.raw(
      `LOCK TABLE ${VAULT_STOCK_TABLES.map((table) => `subkit."${table}"`).join(",")} IN SHARE MODE`,
    ),
  );
  for (const stock of VAULT_STOCK_INVENTORY) {
    const predicates = stock.columns.map((column) => vaultStockColumnPredicate(column));
    const result = await db.execute<{ present: boolean }>(
      sql.raw(
        `SELECT EXISTS(SELECT 1 FROM subkit."${stock.table}" stock WHERE ${predicates.join(" OR ")}) AS present`,
      ),
    );
    if (result.rows[0]?.present !== false) throw new RegistryRewrapScopeError();
  }
}
