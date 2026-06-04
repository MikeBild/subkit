// Immutable, append-only audit log. No update helper. No delete helper.
// See apps/engine/src/db/audit.ts for the write-only interface.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    // idempotency key — matches the id the audit helper generates so retries
    // are safe
    id: uuid("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    // intentionally NOT a foreign key: audit entries must survive
    // tenant deletion (compliance)
    tenant_id: uuid("tenant_id").notNull(),
    actor_type: text("actor_type").notNull(),
    actor_id: uuid("actor_id"),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    result: text("result").notNull(),
    trace_id: text("trace_id"),
    ip: text("ip"),
    user_agent: text("user_agent"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    metadata: jsonb("metadata").default(sql`'{}'::jsonb`).notNull(),
  },
  (t) => [
    index("audit_log_tenant_ts_idx").on(t.tenant_id, t.ts),
    // Covers GET /v1/stats/connectors (action='connector.invoked') and
    // GET /v1/stats/events (?class= → action set): both filter
    // (tenant_id, action) + ts-window bucketing. Added in migration
    // 0035. One full btree covers both routes — simpler ops than a
    // connector-specific partial index.
    index("audit_log_tenant_action_ts_idx").on(t.tenant_id, t.action, t.ts),
    check("audit_log_actor_type_check", sql`${t.actor_type} IN ('user','system_account','system')`),
    check("audit_log_result_check", sql`${t.result} IN ('success','denied','error')`),
  ],
);
