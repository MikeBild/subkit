import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./identity.ts";

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    surface: text("surface").notNull(),
    operation: text("operation").notNull(),
    method: text("method"),
    outcome: text("outcome").notNull(),
    traffic_class: text("traffic_class").notNull().default("organic"),
    request_source: text("request_source").notNull(),
    actor_hmac: text("actor_hmac"),
    session_hmac: text("session_hmac"),
    status_code: integer("status_code"),
    duration_ms: integer("duration_ms"),
    request_bytes: integer("request_bytes"),
    response_bytes: integer("response_bytes"),
    stream_outcome: text("stream_outcome"),
    platform: text("platform"),
    response_mode: text("response_mode"),
    task_phase: text("task_phase"),
    item_count: integer("item_count"),
    active_sessions: integer("active_sessions"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("usage_events_tenant_surface_created_idx").on(t.tenant_id, t.surface, t.created_at),
    index("usage_events_tenant_traffic_created_idx").on(t.tenant_id, t.traffic_class, t.created_at),
    check("usage_events_surface_check", sql`${t.surface} IN ('http','chat','mcp','conversations')`),
    check(
      "usage_events_traffic_class_check",
      sql`${t.traffic_class} IN ('organic','synthetic','internal')`,
    ),
    check(
      "usage_events_nonnegative_measurements_check",
      sql`coalesce(${t.duration_ms}, 0) >= 0 AND coalesce(${t.request_bytes}, 0) >= 0 AND coalesce(${t.response_bytes}, 0) >= 0 AND coalesce(${t.item_count}, 0) >= 0 AND coalesce(${t.active_sessions}, 0) >= 0`,
    ),
  ],
);
