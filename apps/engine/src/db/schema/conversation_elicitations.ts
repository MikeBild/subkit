// Conversation elicitations — generalized pause-resume slots for the
// `askUser.*` tool family. One row per open request for user input.
//
// This table is new; the existing `approval_requests` table (see
// `conversations-extras.ts`) continues to back the legacy approval
// flow for one release window. PR 2 (approval unification) moves
// commit-draft and external-write callers onto this table and then
// retires `approval_requests`.
//
// Columns mirror the AI SDK UI "tool call as form" model:
//   - tool_name identifies which `askUser.*` rendered the prompt
//   - input carries the question metadata (options, fields, summary)
//   - output carries the user's answer once resolved

import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { conversations, conversationToolCalls } from "./conversations.ts";
import { tenants, users } from "./identity.ts";

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
    tool_name: text("tool_name").notNull(),
    summary: text("summary").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    status: elicitationStatusEnum("status").notNull().default("pending"),
    decided_by: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decision_reason: text("decision_reason"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("conversation_elicitations_conv_status_idx").on(t.conversation_id, t.status)],
);
