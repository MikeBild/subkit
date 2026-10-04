import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
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
    last_turn_error: jsonb("last_turn_error").$type<{
      code: string;
      message: string;
      at: string;
      kind?: string;
      retry_at?: string;
    } | null>(),
    owner_id: uuid("owner_id"),
    model: text("model"),
    title: text("title"),
    memory: text("memory"),
    loaded_skills: jsonb("loaded_skills")
      .$type<Array<{ slug: string; last_turn: number }>>()
      .default([])
      .notNull(),
    turn_count: integer("turn_count").notNull().default(0),
    tool_policies: jsonb("tool_policies").$type<Record<string, string>>().default({}).notNull(),
    topic_embedding: real("topic_embedding").array(),
    topic_embedding_model: text("topic_embedding_model"),
    origin_client: text("origin_client"),
    surface: text("surface"),
    title_locked: boolean("title_locked").notNull().default(false),
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
    model: text("model"),
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
    parent_message_id: uuid("parent_message_id").references(() => conversationMessages.id, {
      onDelete: "set null",
    }),
    tool: text("tool").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    approval_required: boolean("approval_required").default(false).notNull(),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    approved_by_user_id: uuid("approved_by_user_id"),
    confirmation_state: text("confirmation_state"),
    outcome: text("outcome"),
    confirmation_data: jsonb("confirmation_data"),
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

export const conversationHidden = pgTable(
  "conversation_hidden",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").notNull(),
    hidden_at: timestamp("hidden_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversation_id, t.user_id] }),
    index("conversation_hidden_tenant_user_idx").on(t.tenant_id, t.user_id),
  ],
);
