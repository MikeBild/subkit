// H2: Knowledge Sources — persistent tenant-scoped knowledge from uploaded
// enterprise files (PDF, DOCX, CSV, Excel, Markdown, etc.).
//
// Two tables:
//   - knowledge_sources: one row per uploaded source (metadata, lifecycle,
//     refresh strategy).
//   - knowledge_chunks: one row per chunk carved from the parsed source.
//     A generated tsvector column powers full-text search; GIN index keeps
//     lookups fast.
//
// Budgets (50 MB per source, 500 MB per tenant) are enforced at the service
// layer — the schema just stores what made it through the pipeline.

import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

// ----- enums -----------------------------------------------------------------

export const knowledgeSourceScopeEnum = pgEnum("knowledge_source_scope", ["global", "workflow"]);

export const knowledgeSourceStatusEnum = pgEnum("knowledge_source_status", [
  "active",
  "inactive",
  "processing",
  "error",
]);

export const knowledgeSourceRefreshEnum = pgEnum("knowledge_source_refresh", [
  "manual",
  "scheduled",
  "webhook",
]);

// drizzle-orm has no native tsvector — declare a custom column so the
// field round-trips as a string in JS. The SQL migration installs it as a
// GENERATED column so inserts never need to set it.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

// ----- knowledge_sources -----------------------------------------------------

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    scope: knowledgeSourceScopeEnum("scope").notNull().default("global"),
    workflow_id: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    status: knowledgeSourceStatusEnum("status").notNull().default("active"),
    source_type: text("source_type").notNull(), // file_upload | url | inline
    source_uri: text("source_uri").notNull(), // original filename or URL
    mime_type: text("mime_type"),
    version: text("version").notNull(), // SHA-256 fingerprint of content
    bytes_total: integer("bytes_total").notNull().default(0),
    chunk_count: integer("chunk_count").notNull().default(0),
    refresh_strategy: knowledgeSourceRefreshEnum("refresh_strategy").notNull().default("manual"),
    refresh_cron: text("refresh_cron"),
    refresh_webhook_secret: text("refresh_webhook_secret"),
    last_refreshed_at: timestamp("last_refreshed_at", { withTimezone: true }),
    ...timestamps,
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_sources_tenant_slug_key").on(t.tenant_id, t.slug),
    index("knowledge_sources_tenant_idx").on(t.tenant_id),
    index("knowledge_sources_tenant_scope_idx").on(t.tenant_id, t.scope),
    index("knowledge_sources_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
  ],
);

// ----- knowledge_chunks ------------------------------------------------------

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    knowledge_source_id: uuid("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    title: text("title"),
    path: text("path"),
    content: text("content").notNull(),
    byte_size: integer("byte_size").notNull(),
    fingerprint: text("fingerprint").notNull(),
    tsv: tsvector("tsv"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("knowledge_chunks_tenant_source_ordinal_idx").on(
      t.tenant_id,
      t.knowledge_source_id,
      t.ordinal,
    ),
  ],
);
