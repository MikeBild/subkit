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
import { tenants } from "./identity.ts";

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "awaiting_input",
  "committed",
  "abandoned",
]);

export const conversationRoleEnum = pgEnum("conversation_role", [
  "user",
  "assistant",
  "tool",
  "system",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    target_workflow_id: uuid("target_workflow_id"),
    target_connector_id: uuid("target_connector_id"),
    draft: jsonb("draft"),
    status: conversationStatusEnum("status").notNull(),
    // sk-cli rollout (migration 0018): owner_id identifies the user
    // that created the conversation (used by `/resume` + `sk -c`);
    // model/title are patchable via PATCH /v1/conversations/:id; memory
    // holds the most recent user-supplied memory payload that the LLM
    // context pipeline slots into the assembled prompt at turn time.
    owner_id: uuid("owner_id"),
    model: text("model"),
    title: text("title"),
    memory: text("memory"),
    // Skills the conversation has loaded on-demand via `load_skill`.
    // Persisted so resuming a session keeps the same skill palette in
    // the LLM context.
    loaded_skills: jsonb("loaded_skills").$type<string[]>().default([]).notNull(),
    // Per-tool execution policy overrides (tool name → mode).
    // { run_workflow: "confirm_before_execution", list_workflows: "no_confirm" }
    tool_policies: jsonb("tool_policies").$type<Record<string, string>>().default({}).notNull(),
    ...timestamps,
  },
  (t) => [
    index("conversations_tenant_status_idx").on(t.tenant_id, t.status),
    index("conversations_owner_idx").on(t.tenant_id, t.owner_id, t.updated_at),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: conversationRoleEnum("role").notNull(),
    content: jsonb("content").notNull(),
    tokens_in: integer("tokens_in"),
    tokens_out: integer("tokens_out"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conversation_messages_conv_created_idx").on(t.conversation_id, t.created_at)],
);

export const conversationToolCalls = pgTable(
  "conversation_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // Causal anchor to the assistant message that produced this tool call.
    // Nullable for legacy rows; the parts.ts read path falls back to a
    // time-window join when null. Populated by the loop's wrapper for
    // every new write so the timeline can interleave deterministically.
    parent_message_id: uuid("parent_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    tool: text("tool").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    approval_required: boolean("approval_required").default(false).notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    approved_by_user_id: uuid("approved_by_user_id"),
    // Multi-state confirmation machine (replaces simple approval_required):
    //   proposed | tested | confirmed | declined | partial | oauth_success
    //   | oauth_failure | auto_declined
    confirmation_state: text("confirmation_state"),
    confirmation_data: jsonb("confirmation_data"),
    // Append-only UI-action log per tool call.
    // [{ type: "user_tested" | "user_confirmed" | "user_partial" | "user_declined"
    //    | "auto_declined" | "retry", ts, meta? }]
    interaction_log: jsonb("interaction_log")
      .$type<Array<{ type: string; ts: string; meta?: Record<string, unknown> }>>()
      .default([])
      .notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("conversation_tool_calls_conv_created_idx").on(t.conversation_id, t.created_at),
    index("conversation_tool_calls_parent_msg_idx").on(t.parent_message_id),
  ],
);
