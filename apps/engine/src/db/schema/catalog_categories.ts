import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const catalogCategories = pgTable(
  "catalog_categories",
  {
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    purpose: text("purpose"),
    purpose_source: text("purpose_source").$type<"human" | "llm">(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    redirect_to: text("redirect_to"),
    purpose_pending: boolean("purpose_pending").notNull().default(false),
    purpose_attempted_at: timestamp("purpose_attempted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.name] }),
    check("catalog_categories_revision_positive", sql`${t.revision} > 0`),
    check("catalog_categories_source_valid", sql`${t.purpose_source} IN ('human', 'llm')`),
    check("catalog_categories_purpose_length", sql`length(${t.purpose}) <= 2000`),
    check(
      "catalog_categories_aliases_array",
      sql`jsonb_typeof(${t.aliases}) = 'array' AND jsonb_array_length(${t.aliases}) <= 32`,
    ),
    check(
      "catalog_categories_redirect_not_self",
      sql`${t.redirect_to} IS NULL OR ${t.redirect_to} <> ${t.name}`,
    ),
  ],
);
