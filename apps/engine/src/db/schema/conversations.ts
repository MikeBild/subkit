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
    // sk-cli rollout (migration 0018): owner_id identifies the user
    // that created the conversation (used by `/resume` + `sk -c`);
    // model/title are patchable via PATCH /v1/conversations/:id; memory
    // holds the most recent user-supplied memory payload that the LLM
    // context pipeline slots into the assembled prompt at turn time.
    owner_id: uuid("owner_id"),
    model: text("model"),
    title: text("title"),
    memory: text("memory"),
    // Skills the conversation has loaded on-demand via `load_skill` or
    // via context-driven autoload. Each entry carries the slug plus the
    // `last_turn` it was last relevant on. The loop renders a skill's
    // FULL body only while `(turn_count - last_turn) < K` (K=3, the
    // recency window); outside that window the slug falls back to the
    // always-present skill INDEX and re-promotes on the next match or an
    // explicit `load_skill`. Persisted so resuming a session keeps the
    // same skill palette + recency state in the LLM context.
    loaded_skills: jsonb("loaded_skills")
      .$type<Array<{ slug: string; last_turn: number }>>()
      .default([])
      .notNull(),
    // Monotonic per-conversation turn counter. Incremented once at the
    // start of every `runLoop` invocation and used as the recency clock
    // for `loaded_skills[*].last_turn`. Starts at 0; the first turn
    // becomes 1.
    turn_count: integer("turn_count").notNull().default(0),
    // Per-tool execution policy overrides (tool name → mode).
    // { run_workflow: "confirm_before_execution", list_workflows: "no_confirm" }
    tool_policies: jsonb("tool_policies").$type<Record<string, string>>().default({}).notNull(),
    // Topic embedding for suggest-related-conversations routing — the
    // conversation's first user message embedded with the local model
    // (measured: first message alone matches a title-augmented variant, so
    // no title dependency). Plain real[], no pgvector: the cosine match runs
    // in JS over the caller's bounded owner-scoped candidate set. Nullable,
    // populated out-of-band by backfillConversationTopics so the create path
    // stays fast; embedding_model tags the producer for invalidation.
    topic_embedding: real("topic_embedding").array(),
    topic_embedding_model: text("topic_embedding_model"),
    // Which channel opened this conversation, as `<provider>:<credential-id>`
    // (see `auth/origin.ts`). Credential-bound, so it survives a client that
    // misreports itself at `initialize`. Nullable: a browser session is a person,
    // not a registered client, and has no channel to attribute.
    //
    // Exists so per-client behaviour is measurable over time rather than for a
    // log-retention window — every `conversation_elicitations` row joins here via
    // `conversation_id`, which is what turns "0 of 29 fulfilled" from one number
    // into a per-client matrix. Read-only signal; nothing gates on it.
    origin_client: text("origin_client"),
    // Which surface opened this conversation: `web` (Cockpit), `sk_interactive`,
    // `sk_headless`, `mcp`, `chat` (Slack/Teams/Google Chat) or `api`. The turn
    // loop already knows its surface per turn and used to forget it; the row
    // keeps the opening one so a list can say where a conversation came from.
    surface: text("surface"),
    // True once a person named the conversation (create with title, PATCH,
    // Cockpit rename). The automatic titler never overwrites a locked title.
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
    // How the call ended, in the same vocabulary the Prometheus
    // `conversation_tool_calls_total` counter labels with:
    //   ok | error | denied | pending  (`observability/instrumentation.ts`).
    // Nullable with no backfill on purpose: `output` alone cannot tell a
    // failure from a success (a structured `ok:false` with neither
    // `error_code` nor `message` normalises to a payload byte-identical to a
    // success — see `conversations/tools/result-payload.test.ts`), so a
    // backfill would have to guess. NULL is the honest "unknown" for rows
    // written before this column existed.
    outcome: text("outcome"),
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

/**
 * A person's decision to keep a conversation out of their list. Per user,
 * reversible, never a delete: the conversation stays an audit artefact and
 * every other reader still sees it. Mirrors the reference model's "past
 * chats" trash action without discarding governed history.
 */
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
