// Knowledge Sources — persistent tenant-scoped knowledge from uploaded
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

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantId, timestamps } from "./_common.ts";
import { files } from "./files.ts";
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
    // Auto-generated topical/routing tags (or operator-supplied). REPLACE
    // semantics in the service guard against array-doubling; the GIN index
    // below powers the `&&` overlap tag filter in `searchKnowledge`.
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    scope: knowledgeSourceScopeEnum("scope").notNull().default("global"),
    workflow_id: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    status: knowledgeSourceStatusEnum("status").notNull().default("active"),
    // Terminal ingest-failure message. Set (with status='error') by the
    // knowledge.ingest queue handler on a failed run; cleared on the
    // next successful ingest. Surfaces on the list/get views so an
    // operator can see *why* a refresh broke without reading logs.
    last_error: text("last_error"),
    source_type: text("source_type").notNull(), // file_upload | url | inline | discovery_endpoint_index
    source_uri: text("source_uri").notNull(), // original filename or URL
    // Unified-files pointer. Populated for `source_type='file_upload'`;
    // NULL for the `url|inline|discovery_endpoint_index` variants which
    // continue to read through `source_uri`. ON DELETE SET NULL so a
    // file purge does not cascade-delete the knowledge source row.
    file_id: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
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
    index("knowledge_sources_tenant_tags_idx").using("gin", t.tags),
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
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector('english', (COALESCE(title, '') || ' ') || content)`,
    ),
    // Semantic embedding for hybrid retrieval (FTS prefilter → vector
    // rerank). Stored as a plain real[] — no pgvector extension, because
    // the rerank runs over the small FTS-prefiltered candidate set in JS,
    // not as a corpus-wide ANN scan. Nullable so FTS keeps working before
    // backfill; embedding_model tags the producing model for invalidation.
    embedding: real("embedding").array(),
    embedding_model: text("embedding_model"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("knowledge_chunks_tenant_source_ordinal_idx").on(
      t.tenant_id,
      t.knowledge_source_id,
      t.ordinal,
    ),
    index("knowledge_chunks_tsv_idx").using("gin", t.tsv),
  ],
);
