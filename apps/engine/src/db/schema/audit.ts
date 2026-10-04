import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
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
    index("audit_log_tenant_action_ts_idx").on(t.tenant_id, t.action, t.ts),
    check("audit_log_actor_type_check", sql`${t.actor_type} IN ('user','system_account','system')`),
    check("audit_log_result_check", sql`${t.result} IN ('success','denied','error')`),
  ],
);

export const riskSignalEdges = pgTable("risk_signal_edges", {
  kind: text("kind").primaryKey(),
  active: boolean("active").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
