// P10: conversation history.
//
// Append-only snapshot of the in-memory WorkflowDef draft after every
// structured mutation. The newest ordinal is the "live" draft; earlier
// rows support :undo / visual diff.
//
// Approval requests live in `conversation_elicitations.ts` — a single
// generalized pause-resume surface for every `askUser.*` tool.

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
