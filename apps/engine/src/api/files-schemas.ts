// Zod schemas for the unified files HTTP surface.
//
// Wire shape:
//   - The `id` field on the wire is `fid_<uuid>`. The DB column is a
//     plain `uuid`, so we keep the wire prefix as pure serialisation
//     sugar. `parseFileId` strips the prefix on input; `toFileId`
//     re-adds it on output. Every route handler runs through these
//     two helpers — the DB layer never sees `fid_` strings.
//   - File reference shape inside arbitrary JSON values is
//     `{ "$file": "fid_<uuid>" }`. The reference shape is the same on
//     every surface (HTTP, MCP, tool args, workflow inputs, audit).
//
// The `.openapi("Name")` tags here drive `components.schemas.<Name>`
// keys in the generated OpenAPI document; downstream client codegen
// (SDKs, snapshot tests) reads from those names.

import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// File id wire format
// ---------------------------------------------------------------------------

/** Wire-format file id: `fid_<uuid-v4-style hex/dash>`. The 36-char
 *  tail mirrors `gen_random_uuid()` output (8-4-4-4-12 hex). */
export const FileIdSchema = z
  .string()
  .regex(/^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .openapi("FileId");

/** Strip the `fid_` prefix to obtain the underlying UUID for DB lookups. */
export function parseFileId(wire: string): string {
  if (!wire.startsWith("fid_")) {
    throw new Error(`invalid file id (missing fid_ prefix): ${wire}`);
  }
  return wire.slice("fid_".length);
}

/** Compose the wire-format file id from a raw UUID. */
export function toFileId(uuid: string): string {
  return `fid_${uuid}`;
}

// ---------------------------------------------------------------------------
// Core schemas
// ---------------------------------------------------------------------------

/** Reference leaf used inside arbitrary JSON values to point at a file
 *  managed by the engine. Resolved by `walkAndResolve` before dispatch. */
export const FileRefSchema = z.object({ $file: FileIdSchema }).openapi("FileRef");

/** Status values mirror `file_status` enum in `db/schema/files.ts`. */
export const FileStatusSchema = z
  .enum(["pending", "uploading", "scanning", "ready", "failed", "expired"])
  .openapi("FileStatus");

/** Full file row as returned by GET endpoints. Dates serialise as ISO
 *  strings; `id` carries the `fid_` prefix. Soft-deleted rows are
 *  returned by `GET /v1/files/:id` (download-during-grace) and carry a
 *  non-null `deleted_at`; the list endpoint hides them. */
export const FileSchema = z
  .object({
    id: FileIdSchema,
    status: FileStatusSchema,
    filename: z.string(),
    content_type: z.string().nullable(),
    size_bytes: z.number().int().nonnegative(),
    sha256: z.string().nullable(),
    scan_result: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi("File");

// ---------------------------------------------------------------------------
// Inline upload (POST /v1/files/inline)
// ---------------------------------------------------------------------------

/** Body for the inline-upload sink. `content_base64` is the only encoding
 *  we accept here — JSON-over-HTTP keeps the surface multipart-free. */
export const InlineUploadSchema = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().max(200).optional(),
    content_base64: z.string().min(1),
  })
  .openapi("InlineUpload");

// ---------------------------------------------------------------------------
// Batch create (POST /v1/files/batch-create)
// ---------------------------------------------------------------------------

const SHA256_REGEX = /^[0-9a-f]{64}$/;

/** Per-file entry in a batch-create request. The client supplies known
 *  metadata up front; the engine returns either a presigned PUT URL (new
 *  upload) or a dedup hit pointing at an existing file id. */
export const BatchCreateEntrySchema = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().max(200).optional(),
    size_bytes: z.number().int().nonnegative(),
    /** Optional client-supplied sha256 (hex). When present, enables the
     *  dedup-probe fast path; the server still verifies on finalize. */
    sha256: z.string().regex(SHA256_REGEX).optional(),
  })
  .openapi("BatchCreateEntry");

export const BatchCreateRequestSchema = z
  .object({ files: z.array(BatchCreateEntrySchema).min(1).max(100) })
  .openapi("BatchCreateRequest");

/** Per-file response. `upload_url` is empty for dedup hits. */
export const BatchCreateResponseEntrySchema = z
  .object({
    id: FileIdSchema,
    upload_url: z.string(),
    headers: z.record(z.string(), z.string()),
    expires_in: z.number().int().nonnegative(),
    dedup: z.boolean(),
  })
  .openapi("BatchCreateResponseEntry");

export const BatchCreateResponseSchema = z
  .object({ files: z.array(BatchCreateResponseEntrySchema) })
  .openapi("BatchCreateResponse");

// ---------------------------------------------------------------------------
// Finalize (POST /v1/files/:id/finalize)
// ---------------------------------------------------------------------------

/** Client-asserted sha256 of the uploaded bytes. The server recomputes
 *  the digest from the object store and rejects on mismatch (422). */
export const FinalizeRequestSchema = z
  .object({ sha256: z.string().regex(SHA256_REGEX) })
  .openapi("FinalizeRequest");

// ---------------------------------------------------------------------------
// Link (POST /v1/files/:id/links)
// ---------------------------------------------------------------------------

/** `resource_type` mirrors the `file_link_resource` enum exactly so the
 *  DB INSERT never has to translate. */
export const LinkRequestSchema = z
  .object({
    resource_type: z.enum([
      "conversation",
      "knowledge_source",
      "skill",
      "connector",
      "workflow_run",
      "discovery_run",
    ]),
    resource_id: z.string().uuid(),
    slug: z.string().min(1).max(128).optional(),
    role: z.string().min(1).max(64).optional(),
  })
  .openapi("LinkRequest");

export const FileLinkSchema = z
  .object({
    id: z.string().uuid(),
    file_id: FileIdSchema,
    resource_type: z.string(),
    resource_id: z.string().uuid(),
    slug: z.string().nullable(),
    role: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("FileLink");

// ---------------------------------------------------------------------------
// Stats (GET /v1/files/stats)
// ---------------------------------------------------------------------------

export const FileStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    by_status: z.record(z.string(), z.number().int().nonnegative()),
    by_size_bucket: z.record(z.string(), z.number().int().nonnegative()),
    dedup_hits: z.number().int().nonnegative(),
    scan_verdicts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .openapi("FileStats");

// ---------------------------------------------------------------------------
// List (GET /v1/files)
// ---------------------------------------------------------------------------

/** Query parameters for the list endpoint. `linked_to` accepts the
 *  `resource_type:resource_id` syntax shared with the CLI. */
export const ListFilesQuerySchema = z
  .object({
    status: FileStatusSchema.optional(),
    linked_to: z
      .string()
      .regex(/^[a-z_]+:[0-9a-f-]{36}$/)
      .optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .openapi("ListFilesQuery");

export const FileListResponseSchema = z
  .object({
    items: z.array(FileSchema),
    next_cursor: z.string().nullable().optional(),
  })
  .openapi("FileList");

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Hard cap on inline-upload payload size. Above this the client must
 *  go through the presigned-PUT path (`/v1/files/batch-create` →
 *  `PUT <upload_url>` → `/v1/files/:id/finalize`). Mirrors the legacy
 *  10 MB conversation-attachment cap, halved because base64 inflates
 *  the JSON body by ~33% so a 5 MiB payload lands as ~7 MiB on the wire. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Inferred TS types
// ---------------------------------------------------------------------------

export type FileWire = z.infer<typeof FileSchema>;
export type InlineUpload = z.infer<typeof InlineUploadSchema>;
export type BatchCreateRequest = z.infer<typeof BatchCreateRequestSchema>;
export type BatchCreateResponse = z.infer<typeof BatchCreateResponseSchema>;
export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>;
export type LinkRequest = z.infer<typeof LinkRequestSchema>;
export type FileLinkWire = z.infer<typeof FileLinkSchema>;
export type FileStats = z.infer<typeof FileStatsSchema>;
export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;
