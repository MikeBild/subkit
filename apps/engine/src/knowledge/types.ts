import { z } from "@hono/zod-openapi";
import type { RawChunk } from "../docs-ingestion/types.ts";

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
    tags: z.array(z.string()),
    scope: KnowledgeSourceScopeSchema,
    workflow_id: z.string().nullable(),
    status: KnowledgeSourceStatusSchema,
    /** Terminal ingest-failure message; null when the last ingest succeeded. */
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
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    scope: KnowledgeSourceScopeSchema.optional(),
    workflow_id: z.string().uuid().optional(),
    refresh_strategy: z.enum(["manual", "scheduled"]).optional(),
    refresh_cron: z.string().optional(),
  })
  .openapi("CreateKnowledgeSourceBody");

export type CreateKnowledgeSourceInput = z.infer<typeof CreateKnowledgeSourceSchema>;

/**
 * Web-scraper — inline JSON body for POST /v1/knowledge-sources.
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
  /** When set, must be a fully-qualified URL — `https://example.com/page`.
   *  Rejects path-shaped values like `../etc/passwd` so the audit-log
   *  `source_uri` is trustworthy provenance. Optional; defaults to a
   *  derived filename when absent. */
  source_uri: z.string().url().optional(),
}).openapi("CreateKnowledgeSourceInlineBody");

export type CreateKnowledgeSourceInlineInput = z.infer<typeof CreateKnowledgeSourceInlineSchema>;

/**
 * Knowledge bundle — a directory of markdown files posted as one JSON body
 * (`sk knowledge-sources import`, REPL `/knowledge import`). One Knowledge
 * Source per bundle, one chunk per file; frontmatter is read tolerantly
 * (OKF-compatible by construction — see `bundle.ts`). Upsert by slug: an
 * unchanged bundle is a no-op, a changed one re-ingests in place.
 */
export const BundleFileSchema = z
  .object({
    path: z.string().min(1).max(512),
    content: z.string(),
  })
  .openapi("KnowledgeBundleFile");

export const CreateKnowledgeSourceBundleSchema = CreateKnowledgeSourceSchema.extend({
  files: z.array(BundleFileSchema).min(1).max(500),
})
  // Enforced at the Zod boundary so a missing workflow_id is a 422
  // validation error (the service throw would otherwise surface as 500).
  .refine((body) => body.scope !== "workflow" || body.workflow_id !== undefined, {
    message: "workflow_id is required when scope is 'workflow'",
    path: ["workflow_id"],
  })
  .openapi("CreateKnowledgeSourceBundleBody");

export type CreateKnowledgeSourceBundleInput = z.infer<typeof CreateKnowledgeSourceBundleSchema>;

export const UpdateKnowledgeSourceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
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
  /** Human-readable name of the owning Knowledge Source — provenance for the model. */
  source_name: string;
  /** Topical tags on the owning Knowledge Source. */
  source_tags: string[];
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
  /** Web-scraper — when the source comes from an inline JSON body
   *  rather than a file upload, the route stamps these on the row so
   *  later refreshes know where the content originated. Defaults to
   *  `"file_upload"` + `upload.filename` for back-compat. */
  source_type_override?: "file_upload" | "inline" | "url" | "seed" | "bundle";
  source_uri_override?: string;
  /** Pre-parsed chunks (bundle imports): skips `parseFileToChunks` and feeds
   *  the existing fingerprint/dedup/insert pipeline directly — one chunk per
   *  bundle file, `path` = bundle-relative path. */
  parsed_chunks?: RawChunk[];
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

export interface AnalyzeKnowledgeSourceParams {
  tenant_id: string;
  id: string;
  actor_id: string | null;
  /** When true, overwrite an existing description; otherwise only fill a null one. */
  force?: boolean;
}

export interface SearchKnowledgeParams {
  tenant_id: string;
  query: string;
  scope?: KnowledgeSourceScope;
  workflow_id?: string;
  knowledge_source_ids?: string[];
  /** Narrow results to sources carrying any of these tags (tenant-scoped). */
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
  /** See `CreateKnowledgeSourceParams.parsed_chunks`. */
  parsed_chunks?: RawChunk[];
}

// ----- bundle upsert ---------------------------------------------------------

export interface UpsertKnowledgeBundleParams {
  tenant_id: string;
  actor_id: string | null;
  input: CreateKnowledgeSourceInput;
  files: { path: string; content: string }[];
}

export interface KnowledgeBundleUpsertResult {
  knowledge_source: KnowledgeSourceView;
  outcome: "created" | "updated" | "unchanged";
  /** Chunks now stored for the source (post dedup/split). */
  ingested_count: number;
  /** Reserved (`index.md`/`log.md`) and duplicate-path files skipped by the parser. */
  skipped_count: number;
  skipped_files: string[];
}

// ----- chunk read ------------------------------------------------------------

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
  /** Narrow to chunks whose `path` equals this bundle-relative path. */
  path?: string;
  limit?: number;
  offset?: number;
}
