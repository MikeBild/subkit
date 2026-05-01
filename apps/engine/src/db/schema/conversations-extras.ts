// P10: conversation history.
//
// Append-only snapshot of the in-memory WorkflowDef draft after every
// structured mutation. The newest ordinal is the "live" draft; earlier
// rows support :undo / visual diff.
//
// Approval requests live in `conversation_elicitations.ts` — a single
// generalized pause-resume surface for every `askUser.*` tool.

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { conversations } from "./conversations.ts";
import { tenants } from "./identity.ts";

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

// Conversation attachments (migration 0028).
//
// File refs uploaded to a conversation. Referenced by the LLM via the
// `@attachment:<slug>` token; sdk-wrap resolves the token to the file body
// before tool dispatch. The `slug` is derived from the original filename
// (sanitised) and unique within the conversation.
//
// `preview` holds the first ~2000 chars of text/JSON/YAML content so the
// LLM can reason about it without the full body landing in context.
export const conversationAttachments = pgTable(
  "conversation_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    original_filename: text("original_filename").notNull(),
    content_type: text("content_type"),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storage_uri: text("storage_uri").notNull(),
    sha256: text("sha256").notNull(),
    preview: text("preview"),
    files_api_id: text("files_api_id"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("conv_attach_conv_slug_uq").on(t.conversation_id, t.slug),
    index("conv_attach_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);

// Conversation draft snapshots (migration 0028).
//
// Recovery points taken automatically after each draft-writing tool call.
// Crucially: NOT an auto-commit — just a rollback anchor. Explicit
// `save_workflow_draft` is still required to persist a workflow.
//
// LRU cap enforced at the service layer (max 10 per conversation).
export const conversationDraftSnapshots = pgTable(
  "conversation_draft_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turn_index: integer("turn_index").notNull(),
    draft: jsonb("draft").notNull(),
    label: text("label"),
    snapshot_at: timestamp("snapshot_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("conv_draft_snap_conv_snap_idx").on(t.conversation_id, t.snapshot_at)],
);
