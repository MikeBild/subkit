import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  customType,
  index,
  pgEnum,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const executionModeEnum = pgEnum("execution_mode", ["dev", "prod"]);

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

export const timestamps = {
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const tenantId = () => uuid("tenant_id").notNull();

export const catalogMetadata = () => ({
  description: text("description"),
  category: text("category").notNull().default("other"),
  description_source: text("description_source").notNull().default("llm"),
  category_source: text("category_source").notNull().default("llm"),
  catalog_input_hash: text("catalog_input_hash"),
  catalog_described_at: timestamp("catalog_described_at", { withTimezone: true }),
});

export function catalogMetadataConstraints(
  table: string,
  t: {
    tenant_id: AnyPgColumn;
    category: AnyPgColumn;
    description_source: AnyPgColumn;
    category_source: AnyPgColumn;
  },
) {
  return [
    index(`${table}_tenant_category_idx`).on(t.tenant_id, t.category),
    check(
      `${table}_category_format`,
      sql`${t.category} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(${t.category}) <= 40`,
    ),
    check(
      `${table}_catalog_sources`,
      sql`${t.description_source} IN ('human', 'llm') AND ${t.category_source} IN ('human', 'llm')`,
    ),
  ];
}
