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
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        "slug must be lowercase alphanumeric with hyphens/underscores",
      )
      .optional(),
    description: z.string().max(2000).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().optional(),
  })
  .openapi("CreateKnowledgeSourceBody");

export type CreateKnowledgeSourceInput = z.infer<typeof CreateKnowledgeSourceSchema>;

/**
 * Web-scraper #144 — inline JSON body for POST /v1/knowledge-sources.
 *
 * Recipes (most notably `crawl-sitemap-to-knowledge`) post a single
 * page's extracted markdown directly, without a multipart upload. The
 * route detects `Content-Type: application/json` and parses against
 * this schema; the service routes the content through the existing
 * chunker so dedup, budget enforcement, and fingerprinting are
 * inherited verbatim.
 */
export const CreateKnowledgeSourceInlineSchema = CreateKnowledgeSourceSchema.extend({
  content: z.string().min(1),
  mime_type: z.string().default("text/markdown"),
  source_uri: z.string().min(1).optional(),
}).openapi("CreateKnowledgeSourceInlineBody");

export type CreateKnowledgeSourceInlineInput = z.infer<typeof CreateKnowledgeSourceInlineSchema>;

export const UpdateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
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
  /** ISO-8601 timestamp of the source's last successful refresh. */
  fetched_at: string | null;
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
  /** Web-scraper #144 — when the source comes from an inline JSON body
   *  rather than a file upload, the route stamps these on the row so
   *  later refreshes know where the content originated. Defaults to
   *  `"file_upload"` + `upload.filename` for back-compat. */
  source_type_override?: "file_upload" | "inline" | "url";
  source_uri_override?: string;
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
