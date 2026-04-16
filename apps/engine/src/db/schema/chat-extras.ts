// P12 chat extras — link-token table only.
//
// `chat_oauth_states` is intentionally left out of P12 (see plan);
// full install-time OAuth lands in a later phase.

import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const chatLinkTokens = pgTable(
  "chat_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    workspace_id: text("workspace_id").notNull(),
    token: text("token").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("chat_link_tokens_token_key").on(t.token)],
);
