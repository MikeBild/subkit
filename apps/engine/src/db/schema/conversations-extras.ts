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
