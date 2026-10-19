import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Executor } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";
import {
  ERASED_TENANT_TABLES,
  INDIRECT_TENANT_TABLES,
  PLATFORM_TABLES,
  RETAINED_TENANT_TABLES,
} from "./tenant-erasure-tables.ts";

export function erasureTableOrder(): string[] {
  const tables = Object.values(schema).filter((value) => is(value, PgTable));
  const configs = new Map(
    tables.map((table) => {
      const config = getTableConfig(table);
      return [config.name, config];
    }),
  );
  const classified = [
    ...ERASED_TENANT_TABLES,
    ...RETAINED_TENANT_TABLES,
    ...INDIRECT_TENANT_TABLES,
    ...PLATFORM_TABLES,
  ];
  if (
    new Set(classified).size !== classified.length ||
    classified.length !== configs.size ||
    classified.some((name) => !configs.has(name))
  )
    throw new Error("tenant_erasure_schema_unclassified");
  for (const name of [...ERASED_TENANT_TABLES, ...RETAINED_TENANT_TABLES]) {
    if (!configs.get(name)?.columns.some((column) => column.name === "tenant_id"))
      throw new Error("tenant_erasure_scoped_boundary_changed");
  }
  for (const name of [...PLATFORM_TABLES, ...INDIRECT_TENANT_TABLES]) {
    if (configs.get(name)?.columns.some((column) => column.name === "tenant_id"))
      throw new Error("tenant_erasure_global_boundary_changed");
  }
  for (const name of PLATFORM_TABLES) {
    if (
      configs
        .get(name)
        ?.foreignKeys.some((key) =>
          (ERASED_TENANT_TABLES as readonly string[]).includes(
            getTableConfig(key.reference().foreignTable).name,
          ),
        )
    )
      throw new Error("tenant_erasure_global_reference_unclassified");
  }
  const remaining = new Set<string>(ERASED_TENANT_TABLES);
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining].find(
      (name) =>
        ![...remaining].some(
          (child) =>
            child !== name &&
            configs
              .get(child)
              ?.foreignKeys.some(
                (key) => getTableConfig(key.reference().foreignTable).name === name,
              ),
        ),
    );
    if (!next) throw new Error("tenant_erasure_schema_cycle");
    order.push(next);
    remaining.delete(next);
  }
  for (const name of INDIRECT_TENANT_TABLES) {
    const config = configs.get(name);
    if (
      !config ||
      config.foreignKeys.length === 0 ||
      config.foreignKeys.some((key) => key.onDelete !== "cascade")
    )
      throw new Error("tenant_erasure_indirect_boundary_changed");
  }
  return order;
}

export async function assertNoCrossTenantErasureReferences(
  tenantId: string,
  tx: Executor,
): Promise<void> {
  const erased = new Set<string>(ERASED_TENANT_TABLES);
  for (const table of Object.values(schema).filter((value) => is(value, PgTable))) {
    const config = getTableConfig(table);
    if (!config.columns.some((column) => column.name === "tenant_id")) continue;
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      const parent = getTableConfig(reference.foreignTable).name;
      if (!erased.has(parent)) continue;
      const childColumns = sql.join(
        reference.columns.map((column) => sql.identifier(column.name)),
        sql`, `,
      );
      const parentColumns = sql.join(
        reference.foreignColumns.map((column) => sql.identifier(column.name)),
        sql`, `,
      );
      const result = await tx.execute(
        sql`SELECT 1 FROM ${sql.identifier("subkit")}.${sql.identifier(config.name)} WHERE tenant_id <> ${tenantId} AND (${childColumns}) IN (SELECT ${parentColumns} FROM ${sql.identifier("subkit")}.${sql.identifier(parent)} WHERE tenant_id = ${tenantId}) LIMIT 1`,
      );
      if (result.rows.length > 0) throw new Error("tenant_erasure_cross_tenant_reference");
    }
  }
  const invalidGroups = await tx.execute(
    sql`SELECT 1 FROM subkit.group_role_assignments a JOIN subkit.groups g ON g.id=a.group_id JOIN subkit.roles r ON r.id=a.role_id WHERE r.tenant_id=${tenantId} AND g.tenant_id<>${tenantId} LIMIT 1`,
  );
  const invalidMembers = await tx.execute(
    sql`SELECT 1 FROM subkit.group_members m JOIN subkit.groups g ON g.id=m.group_id JOIN subkit.users u ON u.id=m.user_id WHERE u.tenant_id=${tenantId} AND g.tenant_id<>${tenantId} LIMIT 1`,
  );
  if (invalidGroups.rows.length > 0 || invalidMembers.rows.length > 0)
    throw new Error("tenant_erasure_cross_tenant_reference");
}
