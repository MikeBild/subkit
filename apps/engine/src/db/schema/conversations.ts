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
  "awaiting_approval",
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
    tool: text("tool").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    approval_required: boolean("approval_required").default(false).notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    approved_by_user_id: uuid("approved_by_user_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conversation_tool_calls_conv_created_idx").on(t.conversation_id, t.created_at)],
);
