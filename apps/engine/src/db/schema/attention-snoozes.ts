import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const attentionSnoozes = pgTable(
  "attention_snoozes",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attention_key: text("attention_key").notNull(),
    snoozed_until: timestamp("snoozed_until", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id, t.attention_key] }),
    index("attention_snoozes_until_idx").on(t.tenant_id, t.snoozed_until),
  ],
);
