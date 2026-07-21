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
//
// PR 2's reference to commit-draft is historical: callers were renamed
// `save-workflow-draft` repo-wide and this table now backs the
// save-workflow-draft + external-write confirmation flows.

import {
  boolean,
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
    // Causal anchor to the assistant message that requested user input.
    // Nullable for legacy rows; populated by the loop for new writes.
    parent_message_id: uuid("parent_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    tool_name: text("tool_name").notNull(),
    summary: text("summary").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    status: elicitationStatusEnum("status").notNull().default("pending"),
    // True when this elicitation was satisfied via an MCP-native
    // `elicitation/create` round-trip (the in-process bridge) rather
    // than the DB-pause + `respondElicitation` path. Lets observability
    // distinguish a protocol-native prompt from a portal-surface one.
    protocol_native: boolean("protocol_native").notNull().default(false),
    // A short durable claim held while a polling MCP request is displaying
    // this prompt. The engine can run more than one replica, so an in-memory
    // mutex would still allow duplicate dialogs and duplicate answers.
    delivery_lease_id: uuid("delivery_lease_id"),
    delivery_lease_expires_at: timestamp("delivery_lease_expires_at", { withTimezone: true }),
    delivery_attempts: integer("delivery_attempts").notNull().default(0),
    delivery_last_error: text("delivery_last_error"),
    decided_by: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    // Machine-code decision token — a stable string, not free prose.
    // `resolveElicitation` stores codes like `user_declined`,
    // `user_cancelled`, `oauth_timeout`, `elicitation_transport_failed`,
    // or `superseded_by_new_elicitation` here so the resolution path
    // stays auditable and consumers can switch on it.
    decision_reason: text("decision_reason"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("conversation_elicitations_conv_status_idx").on(t.conversation_id, t.status),
    index("conversation_elicitations_parent_msg_idx").on(t.parent_message_id),
  ],
);
