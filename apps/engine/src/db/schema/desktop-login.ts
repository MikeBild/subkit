import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenants, users } from "./identity.ts";

export const desktopLoginCodes = pgTable(
  "desktop_login_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    auth_identity_id: uuid("auth_identity_id"),
    code_sha256: text("code_sha256").notNull(),
    code_challenge: text("code_challenge").notNull(),
    state_sha256: text("state_sha256").notNull(),
    device_id: uuid("device_id").notNull(),
    device_label: text("device_label").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("desktop_login_codes_sha256_key").on(t.code_sha256),
    index("desktop_login_codes_tenant_user_idx").on(t.tenant_id, t.user_id),
    index("desktop_login_codes_expires_idx").on(t.expires_at),
  ],
);
