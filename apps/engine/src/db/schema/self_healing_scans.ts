import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const selfHealingScans = pgTable(
  "self_healing_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    filters: jsonb("filters").notNull(),
    actor_id: uuid("actor_id"),
    idempotency_key: text("idempotency_key"),
    signals_detected: integer("signals_detected").notNull().default(0),
    candidates_created: integer("candidates_created").notNull().default(0),
    unanchored_detected: integer("unanchored_detected").notNull().default(0),
    duration_ms: integer("duration_ms"),
    status: text("status").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("self_healing_scans_tenant_created_idx").on(t.tenant_id, t.created_at),
    uniqueIndex("self_healing_scans_idem_key").on(t.tenant_id, t.idempotency_key),
  ],
);
