import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderVaultMaintenanceSql } from "../apps/engine/src/db/vault-maintenance-sql.ts";

const directory = join(import.meta.dir, "../apps/engine/src/db/migrations");
const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const entry = journal.entries.find((value) => value.tag.endsWith("_vault_maintenance"));
if (!entry) throw new Error("vault_maintenance_migration_missing");
writeFileSync(join(directory, `${entry.tag}.sql`), renderVaultMaintenanceSql());
