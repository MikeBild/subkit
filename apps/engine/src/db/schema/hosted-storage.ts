import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const hostedStorageObjects = pgTable(
  "hosted_storage_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id),
    storage_key: text("storage_key").notNull(),
    storage_namespace: text("storage_namespace").notNull(),
    declared_bytes: bigint("declared_bytes", { mode: "bigint" }).notNull(),
    state: text("state")
      .$type<"pending" | "retained" | "deleting" | "absence_verified">()
      .notNull()
      .default("pending"),
    absence_verified_at: timestamp("absence_verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hosted_storage_objects_key").on(t.storage_key),
    index("hosted_storage_objects_tenant_state_idx").on(t.tenant_id, t.state),
    check("hosted_storage_objects_size_check", sql`${t.declared_bytes}>0`),
    check(
      "hosted_storage_objects_key_check",
      sql`${t.storage_key} LIKE ('offload/' || ${t.tenant_id}::text || '/%')`,
    ),
    check("hosted_storage_objects_namespace_check", sql`${t.storage_namespace} ~ '^[0-9a-f]{64}$'`),
    check(
      "hosted_storage_objects_state_check",
      sql`${t.state} IN ('pending','retained','deleting','absence_verified')`,
    ),
    check(
      "hosted_storage_objects_absence_check",
      sql`(${t.state}='absence_verified') = (${t.absence_verified_at} IS NOT NULL)`,
    ),
  ],
);
