import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { conversationMessages, conversations } from "./conversations.ts";
import { auditActorKindEnum, tenants } from "./identity.ts";

export const mcpTasks = pgTable(
  "mcp_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turn_seq: integer("turn_seq").notNull(),
    kind: text("kind").notNull().$type<"start" | "append" | "respond_elicitation">(),
    job_id: text("job_id"),
    request_source: text("request_source"),
    origin_source: text("origin_source"),
    audit_trace_id: text("audit_trace_id"),
    actor_id: uuid("actor_id"),
    actor_kind: auditActorKindEnum("actor_kind"),
    user_message_id: uuid("user_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    result: jsonb("result"),
    failure_reason: text("failure_reason"),
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    phase: text("phase"),
    last_action: text("last_action"),
    progress_step: text("progress_step"),
    heartbeat_at: timestamp("heartbeat_at", { withTimezone: true }),
    parked_until: timestamp("parked_until", { withTimezone: true }),
    parked_reason: text("parked_reason"),
    ...timestamps,
  },
  (t) => [
    index("mcp_tasks_conv_turn_idx").on(t.tenant_id, t.conversation_id, t.turn_seq),
    index("mcp_tasks_tenant_created_idx").on(t.tenant_id, t.created_at),
    check("mcp_tasks_kind_check", sql`${t.kind} IN ('start','append','respond_elicitation')`),
    check(
      "mcp_tasks_actor_kind_check",
      sql`(${t.actor_id} IS NULL) = (${t.actor_kind} IS NULL) AND (${t.actor_kind} IS NULL OR ${t.actor_kind} <> 'system')`,
    ),
  ],
);
