// P10: conversation history + approvals.
//
// Two additional tables that bolt onto the existing `conversations`
// cluster without touching its columns:
//
//   1. conversation_drafts — append-only snapshot of the in-memory
//      WorkflowDef draft after every structured mutation. The newest
//      ordinal is the "live" draft; earlier rows support :undo /
//      visual diff.
//
//   2. approval_requests — open slots for sensitive tool calls that
//      must pause the loop (commit_draft, external writes). The HTTP
//      / MCP approve+reject endpoints flip `status` and the loop
//      resumes on the next tick.

import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { conversations, conversationToolCalls } from "./conversations.ts";
import { tenants, users } from "./identity.ts";

export const approvalKindEnum = pgEnum("approval_kind", [
  "commit_draft",
  "external_write",
  "other",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "timeout",
]);

export const conversationDrafts = pgTable(
  "conversation_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ordinal: text("ordinal").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conversation_drafts_conv_ordinal_idx").on(t.conversation_id, t.ordinal)],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    tool_call_id: uuid("tool_call_id").references(() => conversationToolCalls.id, {
      onDelete: "set null",
    }),
    kind: approvalKindEnum("kind").notNull(),
    summary: text("summary").notNull(),
    diff: jsonb("diff"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    decided_by: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decision_reason: text("decision_reason"),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("approval_requests_conv_status_idx").on(t.conversation_id, t.status)],
);
