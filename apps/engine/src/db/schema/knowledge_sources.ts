import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeVersionContent } from "../../knowledge/core/version-content.ts";
import { catalogMetadata, catalogMetadataConstraints, tenantId, timestamps } from "./_common.ts";
import { files } from "./files.ts";
import { tenants } from "./identity.ts";
import { workflows } from "./workflows.ts";

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

const regconfig = customType<{ data: string; driverData: string }>({
  dataType() {
    return "regconfig";
  },
});

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const knowledgeSources = pgTable(
  "knowledge_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...catalogMetadata(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    scope: knowledgeSourceScopeEnum("scope").notNull().default("global"),
    workflow_id: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    status: knowledgeSourceStatusEnum("status").notNull().default("active"),
    last_error: text("last_error"),
    source_type: text("source_type").notNull(),
    source_uri: text("source_uri").notNull(),
    file_id: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    mime_type: text("mime_type"),
    version: text("version").notNull(),
    bytes_total: integer("bytes_total").notNull().default(0),
    chunk_count: integer("chunk_count").notNull().default(0),
    refresh_strategy: knowledgeSourceRefreshEnum("refresh_strategy").notNull().default("manual"),
    refresh_cron: text("refresh_cron"),
    last_refreshed_at: timestamp("last_refreshed_at", { withTimezone: true }),
    review_due_at: timestamp("review_due_at", { withTimezone: true }),
    ...timestamps,
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_sources_tenant_slug_key")
      .on(t.tenant_id, t.slug)
      .where(sql`deleted_at IS NULL`),
    index("knowledge_sources_tenant_idx").on(t.tenant_id),
    index("knowledge_sources_tenant_scope_idx").on(t.tenant_id, t.scope),
    index("knowledge_sources_tenant_workflow_idx").on(t.tenant_id, t.workflow_id),
    index("knowledge_sources_tenant_tags_idx").using("gin", t.tags),
    ...catalogMetadataConstraints("knowledge_sources", t),
  ],
);

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
    fts_config: regconfig("fts_config").notNull().default(sql`'english'::regconfig`),
    tsv: tsvector("tsv").generatedAlwaysAs(
      sql`to_tsvector(fts_config, (COALESCE(title, '') || ' ') || content)`,
    ),
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

export type { KnowledgeVersionContent } from "../../knowledge/core/version-content.ts";

export const knowledgeSourceVersions = pgTable(
  "knowledge_source_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: tenantId().references(() => tenants.id, { onDelete: "cascade" }),
    knowledge_source_id: uuid("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: jsonb("content").$type<KnowledgeVersionContent>().notNull(),
    content_hash: text("content_hash").notNull(),
    author_user_id: uuid("author_user_id"),
    author_system_account_id: uuid("author_system_account_id"),
    note: text("note"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("knowledge_source_versions_source_version_key").on(
      t.knowledge_source_id,
      t.version,
    ),
    index("knowledge_source_versions_tenant_source_idx").on(t.tenant_id, t.knowledge_source_id),
  ],
);
