import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { authIdentities } from "./identity.ts";

export const identityRecoverySessions = pgTable(
  "identity_recovery_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auth_identity_id: uuid("auth_identity_id")
      .notNull()
      .references(() => authIdentities.id),
    token_sha256: text("token_sha256").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("identity_recovery_expiry_idx").on(t.expires_at)],
);
