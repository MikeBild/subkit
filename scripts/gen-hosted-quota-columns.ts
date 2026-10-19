import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../apps/engine/src/db/schema/index.ts";

const columns = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => {
    const config = getTableConfig(table);
    return {
      table: config.name,
      columns: config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        enum: column.enumValues ?? null,
      })),
      tenant: config.columns.some((column) => column.name === "tenant_id"),
    };
  })
  .sort((a, b) => a.table.localeCompare(b.table));
const target = new URL("../apps/engine/src/db/hosted-quota-columns.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(columns, null, 2)}\n`);

execFileSync(process.execPath, ["x", "biome", "format", "--write", fileURLToPath(target)], {
  cwd: new URL("..", import.meta.url),
  stdio: "pipe",
});

const directory = new URL("../apps/engine/src/db/migrations/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const quota = journal.entries.find((entry) => entry.tag.endsWith("_hosted_resource_quota"));
if (!quota) throw new Error("hosted_quota_migration_missing");
const snapshot = JSON.parse(
  readFileSync(
    new URL(`meta/${String(quota.idx - 1).padStart(4, "0")}_snapshot.json`, directory),
    "utf8",
  ),
) as {
  tables: Record<string, { name: string; columns: Record<string, { name: string; type: string }> }>;
  enums: Record<string, { name: string; values: string[] }>;
};
const enums = new Map(Object.values(snapshot.enums).map((value) => [value.name, value.values]));
const baseline = Object.values(snapshot.tables)
  .map((table) => ({
    table: table.name,
    columns: Object.values(table.columns).map((column) => ({
      name: column.name,
      type: column.type,
      enum: enums.get(column.type) ?? null,
    })),
    tenant: Object.hasOwn(table.columns, "tenant_id"),
  }))
  .sort((a, b) => a.table.localeCompare(b.table));
const baselineTarget = new URL(
  "../apps/engine/src/db/hosted-quota-baseline-columns.json",
  import.meta.url,
);
writeFileSync(baselineTarget, `${JSON.stringify(baseline, null, 2)}\n`);
execFileSync(process.execPath, ["x", "biome", "format", "--write", fileURLToPath(baselineTarget)], {
  cwd: new URL("..", import.meta.url),
  stdio: "pipe",
});
