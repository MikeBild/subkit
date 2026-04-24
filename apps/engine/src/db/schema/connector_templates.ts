// GC3: tenant-scoped connector template overrides.
//
// The built-in catalogue ships as JSON inside the engine binary. Tenants
// can layer extra templates (or replace built-ins) via rows in this
// table. The HTTP route merges built-ins + this table and dedupes by
// slug, with the tenant override winning.

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
    setup_instructions: text("setup_instructions").notNull().default(""),
    auth_options: jsonb("auth_options").default([]),
    // Schema version. Bumps when ConnectorTemplateSchema adds breaking fields.
    version: integer("version").notNull().default(1),
    // Regex pattern for URL-based template detection.
    url_pattern: text("url_pattern").notNull().default(""),
    // Free-text keywords surfaced to the LLM for discovery.
    keywords: jsonb("keywords").notNull().default([]),
    // Optional inline OpenAPI/GraphQL schema bundled into the template.
    inline_schema: jsonb("inline_schema"),
    // Smart-probe: explicit endpoint/method/status range for connectivity checks.
    probe_endpoint: jsonb("probe_endpoint"),
    // Human-readable credential hints (label, placeholder, doc URL, secret flag).
    credential_hints: jsonb("credential_hints").notNull().default([]),
    // Alternative base URLs keyed by environment (sandbox vs production, etc.).
    base_url_options: jsonb("base_url_options").notNull().default([]),
    // Default pagination strategy + parameters for the LLM authoring context.
    pagination_defaults: jsonb("pagination_defaults"),
    // API capabilities: webhooks, webhook events, rate limits.
    capabilities: jsonb("capabilities")
      .notNull()
      .default({ webhooks: false, webhook_events: [], rate_limits: null }),
    ...timestamps,
  },
  (t) => [uniqueIndex("connector_templates_tenant_slug_key").on(t.tenant_id, t.slug)],
);
