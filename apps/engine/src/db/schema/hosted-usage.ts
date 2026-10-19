import { sql } from "drizzle-orm";
import { bigint, check, jsonb, pgTable } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const hostedTenantUsage = pgTable(
  "hosted_tenant_usage",
  {
    tenant_id: tenantId()
      .primaryKey()
      .references(() => tenants.id),
    logical_bytes: bigint("logical_bytes", { mode: "bigint" }).notNull().default(sql`0`),
    resource_counts: jsonb("resource_counts").$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [check("hosted_tenant_usage_bytes_check", sql`${t.logical_bytes} >= 0`)],
);
