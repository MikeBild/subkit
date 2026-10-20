import { isNull } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const cockpitInstallations = pgTable(
  "cockpit_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    owner_user_id: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cockpit_installations_active_tenant_owner_key")
      .on(t.tenant_id, t.owner_user_id)
      .where(isNull(t.revoked_at)),
    index("cockpit_installations_tenant_owner_idx").on(t.tenant_id, t.owner_user_id),
  ],
);
