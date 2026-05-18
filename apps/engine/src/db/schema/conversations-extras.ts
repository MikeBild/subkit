// P10: conversation history.
//
// Append-only snapshot of the in-memory WorkflowDef draft after every
// structured mutation. The newest ordinal is the "live" draft; earlier
// rows support :undo / visual diff.
//
// Approval requests live in `conversation_elicitations.ts` — a single
// generalized pause-resume surface for every `askUser.*` tool.

import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

// `conversationAttachments` was dropped in migration 0019 — every
// caller now reads from `files` + `file_links` directly. See
// `apps/engine/src/db/schema/files.ts` for the canonical schema.

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
