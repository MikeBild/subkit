import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId } from "./_common.ts";
import { files } from "./files.ts";
import { tenants, users } from "./identity.ts";

export const chatComposerAttachments = pgTable(
  "chat_composer_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    file_id: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("chat_composer_attachments_user_file_key").on(t.tenant_id, t.user_id, t.file_id),
    index("chat_composer_attachments_user_created_idx").on(t.tenant_id, t.user_id, t.created_at),
    index("chat_composer_attachments_expires_idx").on(t.expires_at),
    check("chat_composer_attachments_slug_check", sql`char_length(${t.slug}) BETWEEN 1 AND 255`),
  ],
);

export type ChatComposerAttachmentRow = typeof chatComposerAttachments.$inferSelect;
