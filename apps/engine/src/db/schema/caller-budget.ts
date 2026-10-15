import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const callerBudgetUnits = pgTable(
  "caller_budget_units",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    product_id: text("product_id").notNull(),
    bucket: text("bucket").notNull(),
    principal_id: uuid("principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    unit_key: text("unit_key").notNull(),
    day: date("day").notNull(),
    state: text("state").$type<"reserved" | "committed" | "refunded">().notNull(),
    billable: boolean("billable").notNull().default(false),
    metered: integer("metered").notNull().default(0),
    lease_until: timestamp("lease_until", { withTimezone: true }).notNull(),
    charged_execution_id: uuid("charged_execution_id"),
    ...timestamps,
  },
  (t) => [
    primaryKey({
      name: "caller_budget_units_pk",
      columns: [t.tenant_id, t.bucket, t.principal_id, t.unit_key],
    }),
    check(
      "caller_budget_units_state_check",
      sql`${t.state} IN ('reserved', 'committed', 'refunded')`,
    ),
    index("caller_budget_units_day_idx")
      .on(t.tenant_id, t.bucket, t.principal_id, t.day)
      .where(sql`${t.state} IN ('reserved', 'committed')`),
  ],
);

export const productIdentityTombstones = pgTable(
  "product_identity_tombstones",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    provider_id: text("provider_id").notNull(),
    issuer_url: text("issuer_url").notNull(),
    subject_sha256: text("subject_sha256").notNull(),
    erased_at: timestamp("erased_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("product_identity_tombstones_subject_key").on(
      t.tenant_id,
      t.provider_id,
      t.subject_sha256,
    ),
  ],
);
