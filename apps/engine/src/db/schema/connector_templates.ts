// GC3: tenant-scoped connector template overrides.
//
// The built-in catalogue of 10 templates ships as JSON inside the engine
// binary. Tenants can layer extra templates (or replace built-ins) via
// rows in this table. The HTTP route merges built-ins + this table and
// dedupes by slug, with the tenant override winning.

import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";

export const connectorTemplates = pgTable(
  "connector_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    driver: text("driver").notNull(),
    base_url: text("base_url").notNull(),
    auth_type: text("auth_type").notNull(),
    oauth: jsonb("oauth"),
    default_skill: text("default_skill"),
    ingestion_source: text("ingestion_source").notNull(),
    ingestion_url: text("ingestion_url"),
    icon: text("icon").notNull().default(""),
    description: text("description").notNull().default(""),
    category: text("category"),
    tags: jsonb("tags").default([]),
    setup_hint: text("setup_hint"),
    auth_options: jsonb("auth_options").default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("connector_templates_tenant_slug_key").on(t.tenant_id, t.slug)],
);
