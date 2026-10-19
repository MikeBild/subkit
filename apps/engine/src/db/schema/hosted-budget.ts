import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const hostedBudgetReservations = pgTable(
  "hosted_budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id),
    request_key: text("request_key").notNull(),
    month_bucket: text("month_bucket").notNull(),
    currency: text("currency").notNull(),
    model: text("model").notNull(),
    reserved_microunits: bigint("reserved_microunits", { mode: "bigint" }).notNull(),
    reported_microunits: bigint("reported_microunits", { mode: "bigint" }),
    state: text("state")
      .$type<"reserved" | "settled" | "released" | "reconciliation_required">()
      .notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hosted_budget_reservations_request_key").on(t.tenant_id, t.request_key),
    index("hosted_budget_reservations_month_idx").on(t.month_bucket, t.tenant_id),
    check(
      "hosted_budget_reservations_state_check",
      sql`${t.state} IN ('reserved', 'settled', 'released', 'reconciliation_required')`,
    ),
    check(
      "hosted_budget_reservations_amount_check",
      sql`${t.reserved_microunits} > 0 AND (${t.reported_microunits} IS NULL OR ${t.reported_microunits} >= 0)`,
    ),
    check(
      "hosted_budget_reservations_settled_check",
      sql`${t.state} <> 'settled' OR (${t.reported_microunits} IS NOT NULL AND ${t.reported_microunits} <= ${t.reserved_microunits})`,
    ),
  ],
);
