import { z } from "@hono/zod-openapi";
import { CatalogSourceSchema, CategorySchema, DescriptionSchema } from "../api/catalog-metadata.ts";
import type { RawChunk } from "../docs-ingestion/types.ts";

export const KnowledgeSourceScopeSchema = z.enum(["global", "workflow"]);
export const KnowledgeSourceStatusSchema = z.enum(["active", "inactive", "processing", "error"]);
export const KnowledgeSourceRefreshSchema = z.enum(["manual", "scheduled", "webhook"]);

export type KnowledgeSourceScope = z.infer<typeof KnowledgeSourceScopeSchema>;
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusSchema>;
export type KnowledgeSourceRefresh = z.infer<typeof KnowledgeSourceRefreshSchema>;

export const KnowledgeSourceSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    description_source: CatalogSourceSchema,
    category: z.string(),
    category_source: CatalogSourceSchema,
    tags: z.array(z.string()),
    scope: KnowledgeSourceScopeSchema,
    workflow_id: z.string().nullable(),
    status: KnowledgeSourceStatusSchema,
    last_error: z.string().nullable(),
    source_type: z.string(),
    source_uri: z.string(),
    mime_type: z.string().nullable(),
    version: z.string(),
    bytes_total: z.number().int(),
    chunk_count: z.number().int(),
    refresh_strategy: KnowledgeSourceRefreshSchema,
    refresh_cron: z.string().nullable(),
    last_refreshed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("KnowledgeSource");

export type KnowledgeSourceView = z.infer<typeof KnowledgeSourceSchema>;

export const CreateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        "slug must be lowercase alphanumeric with hyphens/underscores",
      )
      .optional(),
    description: DescriptionSchema.optional(),
    category: CategorySchema.optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().optional(),
  })
  .openapi("CreateKnowledgeSourceBody");

export type CreateKnowledgeSourceInput = z.infer<typeof CreateKnowledgeSourceSchema>;

export const CreateKnowledgeSourceInlineSchema = CreateKnowledgeSourceSchema.extend({
  content: z.string().min(1),
  mime_type: z.string().default("text/markdown"),
  source_uri: z.string().url().optional(),
}).openapi("CreateKnowledgeSourceInlineBody");

export type CreateKnowledgeSourceInlineInput = z.infer<typeof CreateKnowledgeSourceInlineSchema>;

export const BundleFileSchema = z
  .object({
    path: z.string().min(1).max(512),
    content: z.string(),
  })
  .openapi("KnowledgeBundleFile");

export const CreateKnowledgeSourceBundleSchema = CreateKnowledgeSourceSchema.extend({
  files: z.array(BundleFileSchema).min(1).max(500),
})
  .refine((body) => body.scope !== "workflow" || body.workflow_id !== undefined, {
    message: "workflow_id is required when scope is 'workflow'",
    path: ["workflow_id"],
  })
  .openapi("CreateKnowledgeSourceBundleBody");

export type CreateKnowledgeSourceBundleInput = z.infer<typeof CreateKnowledgeSourceBundleSchema>;

export const UpdateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: DescriptionSchema.nullable().optional(),
    category: CategorySchema.nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().nullable().optional(),
  })
  .openapi("UpdateKnowledgeSourceBody");

export type UpdateKnowledgeSourceInput = z.infer<typeof UpdateKnowledgeSourceSchema>;

export interface KnowledgeSearchHit {
  id: string;
  knowledge_source_id: string;
  source_name: string;
  source_tags: string[];
  source_description: string | null;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  fetched_at: string | null;
}

export interface KnowledgeIngestResult {
  knowledge_source_id: string;
  ingested_count: number;
  skipped_count: number;
  total_bytes: number;
  budget_exceeded: boolean;
}

export interface CreateKnowledgeSourceParams {
  tenant_id: string;
  input: CreateKnowledgeSourceInput;
  upload: {
    buffer: Buffer | Uint8Array;
    filename: string;
    mime?: string;
  };
  actor_id: string | null;
  source_type_override?: "file_upload" | "inline" | "url" | "seed" | "bundle";
  source_uri_override?: string;
  parsed_chunks?: RawChunk[];
}

export interface ListKnowledgeSourcesParams {
  tenant_id: string;
  scope?: KnowledgeSourceScope;
  workflow_id?: string;
  status?: KnowledgeSourceStatus;
  category?: string;
  q?: string;
  sort?: "name" | "status" | "source_type" | "bytes_total" | "updated_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface UpdateKnowledgeSourceParams {
  tenant_id: string;
  id: string;
  patch: UpdateKnowledgeSourceInput;
  actor_id: string | null;
}

export interface AnalyzeKnowledgeSourceParams {
  tenant_id: string;
  id: string;
  actor_id: string | null;
  force?: boolean;
}

export interface SearchKnowledgeParams {
  tenant_id: string;
  query: string;
  scope?: KnowledgeSourceScope;
  workflow_id?: string;
  knowledge_source_ids?: string[];
  tags?: string[];
  limit?: number;
}

export interface IngestKnowledgeSourceParams {
  tenant_id: string;
  knowledge_source_id: string;
  upload: {
    buffer: Buffer | Uint8Array;
    filename: string;
    mime?: string;
  };
  actor_id: string | null;
  expected_version?: string;
  parsed_chunks?: RawChunk[];
}

export interface KnowledgeContentDocument {
  path: string;
  content: string;
}

export interface KnowledgeSourceContent {
  knowledge_source_id: string;
  version: string;
  editable: boolean;
  documents: KnowledgeContentDocument[];
}

export interface UpdateKnowledgeSourceContentParams {
  tenant_id: string;
  knowledge_source_id: string;
  expected_version: string;
  path: string;
  content: string;
  actor_id: string | null;
}

export interface UpsertKnowledgeBundleParams {
  tenant_id: string;
  actor_id: string | null;
  input: CreateKnowledgeSourceInput;
  files: { path: string; content: string }[];
}

export interface KnowledgeBundleUpsertResult {
  knowledge_source: KnowledgeSourceView;
  outcome: "created" | "updated" | "unchanged";
  ingested_count: number;
  skipped_count: number;
  skipped_files: string[];
}

export interface KnowledgeChunkView {
  ordinal: number;
  title: string | null;
  path: string | null;
  content: string;
  byte_size: number;
}

export interface ListKnowledgeChunksParams {
  tenant_id: string;
  knowledge_source_id: string;
  path?: string;
  limit?: number;
  offset?: number;
}
