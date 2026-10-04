import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    aliases: jsonb("aliases").notNull().default([]),
    setup_instructions: text("setup_instructions").notNull().default(""),
    auth_options: jsonb("auth_options").default([]),
    version: integer("version").notNull().default(1),
    url_pattern: text("url_pattern").notNull().default(""),
    keywords: jsonb("keywords").notNull().default([]),
    inline_schema: jsonb("inline_schema"),
    probe_endpoint: jsonb("probe_endpoint"),
    credential_hints: jsonb("credential_hints").notNull().default([]),
    base_url_options: jsonb("base_url_options").notNull().default([]),
    pagination_defaults: jsonb("pagination_defaults"),
    capabilities: jsonb("capabilities")
      .notNull()
      .default({ webhooks: false, webhook_events: [], rate_limits: null }),
    ...timestamps,
  },
  (t) => [uniqueIndex("connector_templates_tenant_slug_key").on(t.tenant_id, t.slug)],
);
