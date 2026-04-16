import { z } from "@hono/zod-openapi";

// ----- enums -----------------------------------------------------------------

export const KnowledgeSourceScopeSchema = z.enum(["global", "workflow"]);
export const KnowledgeSourceStatusSchema = z.enum(["active", "inactive", "processing", "error"]);
export const KnowledgeSourceRefreshSchema = z.enum(["manual", "scheduled", "webhook"]);

export type KnowledgeSourceScope = z.infer<typeof KnowledgeSourceScopeSchema>;
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusSchema>;
export type KnowledgeSourceRefresh = z.infer<typeof KnowledgeSourceRefreshSchema>;

// ----- view types ------------------------------------------------------------

export const KnowledgeSourceSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    scope: KnowledgeSourceScopeSchema,
    workflow_id: z.string().nullable(),
    status: KnowledgeSourceStatusSchema,
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

// ----- input types -----------------------------------------------------------

export const CreateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "slug must be lowercase alphanumeric with hyphens/underscores")
      .optional(),
    description: z.string().max(2000).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().optional(),
    refresh_strategy: KnowledgeSourceRefreshSchema.optional(),
    refresh_cron: z.string().optional(),
  })
  .openapi("CreateKnowledgeSourceBody");

export type CreateKnowledgeSourceInput = z.infer<typeof CreateKnowledgeSourceSchema>;

export const UpdateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    refresh_strategy: KnowledgeSourceRefreshSchema.optional(),
    refresh_cron: z.string().nullable().optional(),
  })
  .openapi("UpdateKnowledgeSourceBody");

export type UpdateKnowledgeSourceInput = z.infer<typeof UpdateKnowledgeSourceSchema>;

// ----- search types ----------------------------------------------------------

export interface KnowledgeSearchHit {
  id: string;
  knowledge_source_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
}

// ----- ingest result ---------------------------------------------------------

export interface KnowledgeIngestResult {
  knowledge_source_id: string;
  ingested_count: number;
  skipped_count: number;
  total_bytes: number;
  budget_exceeded: boolean;
}

// ----- service params --------------------------------------------------------

export interface CreateKnowledgeSourceParams {
  tenant_id: string;
  input: CreateKnowledgeSourceInput;
  upload: {
    buffer: Buffer | Uint8Array;
    filename: string;
    mime?: string;
  };
  actor_id: string | null;
}

export interface ListKnowledgeSourcesParams {
  tenant_id: string;
  scope?: KnowledgeSourceScope;
  workflow_id?: string;
  status?: KnowledgeSourceStatus;
  limit?: number;
  offset?: number;
}

export interface UpdateKnowledgeSourceParams {
  tenant_id: string;
  id: string;
  patch: UpdateKnowledgeSourceInput;
  actor_id: string | null;
}

export interface SearchKnowledgeParams {
  tenant_id: string;
  query: string;
  scope?: KnowledgeSourceScope;
  workflow_id?: string;
  knowledge_source_ids?: string[];
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
}
