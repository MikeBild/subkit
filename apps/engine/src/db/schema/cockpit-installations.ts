import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_common.ts";
import { tenants, users } from "./identity.ts";

export const COCKPIT_INSTALLATION_KINDS = ["browser", "desktop"] as const;
export type CockpitInstallationKind = (typeof COCKPIT_INSTALLATION_KINDS)[number];

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
    kind: text("kind").notNull().default("browser").$type<CockpitInstallationKind>(),
    device_id: uuid("device_id"),
    device_label: text("device_label"),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cockpit_installations_active_tenant_owner_key")
      .on(t.tenant_id, t.owner_user_id)
      .where(sql`${t.revoked_at} IS NULL AND ${t.kind} = 'browser'`),
    uniqueIndex("cockpit_installations_active_desktop_device_key")
      .on(t.tenant_id, t.owner_user_id, t.device_id)
      .where(sql`${t.revoked_at} IS NULL AND ${t.kind} = 'desktop'`),
    index("cockpit_installations_tenant_owner_idx").on(t.tenant_id, t.owner_user_id),
    check("cockpit_installations_kind_check", sql`${t.kind} in ('browser', 'desktop')`),
    check(
      "cockpit_installations_device_check",
      sql`(${t.kind} = 'desktop' and ${t.device_id} is not null and ${t.device_label} is not null) or (${t.kind} = 'browser' and ${t.device_id} is null and ${t.device_label} is null)`,
    ),
  ],
);
