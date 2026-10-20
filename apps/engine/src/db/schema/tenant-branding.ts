import { sql } from "drizzle-orm";
import { bigint, check, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const tenantBrandingPaletteEnum = pgEnum("tenant_branding_palette", [
  "standard",
  "indigo",
  "teal",
]);

export const tenantBranding = pgTable(
  "tenant_branding",
  {
    tenant_id: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    display_name: text("display_name"),
    subtitle: text("subtitle"),
    palette: tenantBrandingPaletteEnum("palette"),
    logo_light: bytea("logo_light"),
    logo_dark: bytea("logo_dark"),
    ...timestamps,
  },
  (t) => [
    check(
      "tenant_branding_revision_check",
      sql`${t.revision} >= 0 AND ${t.revision} <= 9007199254740991`,
    ),
    check(
      "tenant_branding_display_name_check",
      sql`${t.display_name} IS NULL OR char_length(${t.display_name}) <= 80`,
    ),
    check(
      "tenant_branding_subtitle_check",
      sql`${t.subtitle} IS NULL OR char_length(${t.subtitle}) <= 160`,
    ),
  ],
);
