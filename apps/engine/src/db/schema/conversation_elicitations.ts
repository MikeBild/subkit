import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { conversationMessages, conversations, conversationToolCalls } from "./conversations.ts";
import { auditActorKindEnum, tenants } from "./identity.ts";

export const elicitationStatusEnum = pgEnum("elicitation_status", [
  "pending",
  "resolved",
  "cancelled",
  "timeout",
]);

export const conversationElicitations = pgTable(
  "conversation_elicitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tool_call_id: uuid("tool_call_id").references(() => conversationToolCalls.id, {
      onDelete: "set null",
    }),
    parent_message_id: uuid("parent_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    tool_name: text("tool_name").notNull(),
    summary: text("summary").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    status: elicitationStatusEnum("status").notNull().default("pending"),
    protocol_native: boolean("protocol_native").notNull().default(false),
    delivery_lease_id: uuid("delivery_lease_id"),
    delivery_lease_expires_at: timestamp("delivery_lease_expires_at", { withTimezone: true }),
    delivery_attempts: integer("delivery_attempts").notNull().default(0),
    delivery_last_error: text("delivery_last_error"),
    decided_by: uuid("decided_by"),
    decided_by_kind: auditActorKindEnum("decided_by_kind"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decision_reason: text("decision_reason"),
    expires_at: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    ...timestamps,
  },
  (t) => [
    index("conversation_elicitations_conv_status_idx").on(t.conversation_id, t.status),
    index("conversation_elicitations_parent_msg_idx").on(t.parent_message_id),
    index("conversation_elicitations_expiry_sweep_idx")
      .on(t.expires_at)
      .where(sql`${t.status} = 'pending'`),
    check(
      "conversation_elicitations_decided_by_kind_check",
      sql`(${t.decided_by_kind} IS NULL AND ${t.decided_by} IS NULL) OR (${t.decided_by_kind} = 'unknown' AND ${t.decided_by} IS NULL) OR (${t.decided_by_kind} IS NOT NULL AND ${t.decided_by_kind} IN ('user', 'system_account') AND ${t.decided_by} IS NOT NULL)`,
    ),
  ],
);
