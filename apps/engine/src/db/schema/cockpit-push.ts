import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, tenantId, timestamps } from "./_common.ts";
import { cockpitInstallations } from "./cockpit-installations.ts";
import { sessions, tenants } from "./identity.ts";

export const cockpitPushKeys = pgTable("cockpit_push_keys", {
  tenant_id: tenantId()
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  auth_tag: bytea("auth_tag").notNull(),
  ...timestamps,
});

export const cockpitPushSubscriptions = pgTable(
  "cockpit_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    installation_id: uuid("installation_id")
      .notNull()
      .references(() => cockpitInstallations.id, { onDelete: "cascade" }),
    session_id: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint_sha256: text("endpoint_sha256").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    auth_tag: bytea("auth_tag").notNull(),
    notified_attention_keys: text("notified_attention_keys").array(),
    notified_at: timestamp("notified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cockpit_push_subscriptions_installation_session_key").on(
      t.installation_id,
      t.session_id,
    ),
    index("cockpit_push_subscriptions_tenant_installation_idx").on(t.tenant_id, t.installation_id),
    index("cockpit_push_subscriptions_session_idx").on(t.session_id),
  ],
);
