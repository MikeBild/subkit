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
import { FILE_LINK_RESOURCE_TYPES } from "@shared/index.ts";

// ---------------------------------------------------------------------------
// File id wire format
// ---------------------------------------------------------------------------

/** Wire-format file id: `fid_<uuid-v4-style hex/dash>`. The 36-char
 *  tail mirrors `gen_random_uuid()` output (8-4-4-4-12 hex). */
export const FileIdSchema = z
  .string()
  .regex(/^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .openapi("FileId");

/** Strip the `fid_` prefix to obtain the underlying UUID for DB lookups.
 *  Returns `null` when the input is missing the `fid_` prefix so callers
 *  can branch on a typed result instead of catching a generic `Error`.
 *  Most route handlers validate the path/body shape via `FileIdSchema`
 *  (Zod) before calling this — in that path use `parseFileIdOrThrow` to
 *  assert the contract (a `null` here would indicate a Zod regression). */
export function parseFileId(wire: string): string | null {
  if (!wire.startsWith("fid_")) return null;
  return wire.slice("fid_".length);
}

/** Thin throwing wrapper around `parseFileId` for call sites that have
 *  already validated the wire shape via Zod (`FileIdSchema`) and want a
 *  loud failure if the invariant ever breaks. */
export function parseFileIdOrThrow(wire: string): string {
  const uuid = parseFileId(wire);
  if (uuid === null) {
    throw new Error(`invalid file id (missing fid_ prefix): ${wire}`);
  }
  return uuid;
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
    /** Tenant-unique name of the file, kept across rename and replace. */
    slug: z.string().nullable(),
    /** `@attachment:<slug>` — accepted wherever a `fid_` reference is
     *  (chat text, `{ "$file": … }` leaves in workflow inputs). */
    reference: z.string().nullable(),
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

/** Hard ceiling on any authenticated streamed upload. A client may declare an
 *  oversize `size_bytes` at batch-create time; we reject the entry at
 *  the schema layer before creating a slot. The finalize verifier
 *  re-enforces this against the row before doing the digest read so a
 *  pre-cap-rollout token in flight cannot drive the engine into a
 *  multi-GB verification read. The shared object-store adapter selects
 *  single PUT or 64 MiB multipart parts underneath this endpoint. */
export const MAX_STREAM_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
/** Compatibility alias for SDKs compiled against the former presign path. */
export const MAX_PRESIGN_BYTES = MAX_STREAM_UPLOAD_BYTES;

/** Same ceiling, surfaced as a finalize-side guard name so the call
 *  sites read symmetrically. They are intentionally one constant; if a
 *  future wave splits the two (e.g. multipart raising the upload ceiling
 *  while finalize keeps a smaller streamed-digest budget) the names give
 *  the right knob to turn. */
export const MAX_FINALIZE_VERIFY_BYTES = MAX_STREAM_UPLOAD_BYTES;

/** Per-file entry in a batch-create request. The client supplies known
 *  metadata up front; the engine returns either an authenticated PUT endpoint (new
 *  upload) or a dedup hit pointing at an existing file id. The
 *  `MAX_STREAM_UPLOAD_BYTES` cap on `size_bytes` is the engine-side defence
 *  against a rogue client reserving a 100 GB slot. */
export const BatchCreateEntrySchema = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().max(200).optional(),
    size_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_STREAM_UPLOAD_BYTES, {
        message: `size_bytes exceeds upload ceiling of ${MAX_STREAM_UPLOAD_BYTES} bytes`,
      }),
    /** Optional client-supplied sha256 (hex). When present, enables the
     *  dedup-probe fast path; the server still verifies on finalize. */
    sha256: z.string().regex(SHA256_REGEX).optional(),
  })
  .openapi("BatchCreateEntry");

export const BatchCreateRequestSchema = z
  .object({ files: z.array(BatchCreateEntrySchema).min(1).max(100) })
  .openapi("BatchCreateRequest");

/** Per-file response. `upload_url` is an authenticated, relative engine PUT
 *  endpoint and is empty for dedup hits. Clients carry their normal Bearer
 *  credential to this relative URL; they must never forward it to an absolute
 *  legacy/provider URL. */
export const BatchCreateResponseEntrySchema = z
  .object({
    id: FileIdSchema,
    upload_url: z.string().openapi({
      description:
        "Authenticated relative engine PUT endpoint; empty for dedup hits. Carry the normal Bearer credential only when the URL is relative.",
    }),
    headers: z.record(z.string(), z.string()).openapi({
      description: "Required upload headers, including the known content-length.",
    }),
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

/** Re-exported from `@shared/files-constants` so the engine, CLI, and
 *  any other client-package surface share one enum. See the constant's
 *  docstring for the rationale; bind the Zod / OpenAPI schema to the
 *  shared tuple so renames / additions flow through every surface. */
export { FILE_LINK_RESOURCE_TYPES };

export const FileLinkResourceTypeSchema = z
  .enum(FILE_LINK_RESOURCE_TYPES)
  .openapi("FileLinkResourceType");

/** `resource_type` mirrors the `file_link_resource` enum exactly so the
 *  DB INSERT never has to translate. */
export const LinkRequestSchema = z
  .object({
    resource_type: FileLinkResourceTypeSchema,
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
 *  `resource_type:resource_id` syntax shared with the CLI.
 *
 *  The regex anchors `resource_type` to the exact union accepted by
 *  `LinkRequestSchema` and `resource_id` to a strict canonical UUID.
 *  A typo like `?linked_to=conversaton:<uuid>` returns 400 instead of
 *  silently no-matching every row. The list handler relies on this
 *  guarantee — it casts `rtype` straight to the drizzle enum without
 *  re-validating. Keep this enum in sync with `LinkRequestSchema`. */
const LINKED_TO_RESOURCE_TYPES_PATTERN = FILE_LINK_RESOURCE_TYPES.join("|");
const LINKED_TO_PATTERN = new RegExp(
  `^(?:${LINKED_TO_RESOURCE_TYPES_PATTERN}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

export const ListFilesQuerySchema = z
  .object({
    status: FileStatusSchema.optional(),
    linked_to: z.string().regex(LINKED_TO_PATTERN).optional(),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["filename", "content_type", "size_bytes", "status", "created_at"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    cursor: z.string().optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .openapi("ListFilesQuery");

/** A listed file with how many workflows and conversations use it — the
 *  same counting as `GET /v1/files/{id}/usage`. */
export const FileListItemSchema = FileSchema.extend({
  usage: z.object({
    workflows: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
  }),
}).openapi("FileListItem");

export const FileListResponseSchema = z
  .object({
    items: z.array(FileListItemSchema),
    total: z.number().int().nonnegative(),
    next_cursor: z.string().nullable().optional(),
  })
  .openapi("FileList");

// ---------------------------------------------------------------------------
// Rename (PATCH /v1/files/{id}) and usage (GET /v1/files/{id}/usage)
// ---------------------------------------------------------------------------

/** A new name for a stored file. Its id — the `$file` reference workflows
 *  and conversations hold — does not change. */
export const RenameFileSchema = z
  .object({ filename: z.string().trim().min(1).max(255) })
  .openapi("RenameFile");

/** Who uses a file: the workflows whose current version references it and
 *  the conversations it is attached to. `other` counts the remaining links
 *  (knowledge sources, skills, connectors, runs) without naming them. */
export const FileUsageSchema = z
  .object({
    workflows: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    conversations: z.array(z.object({ id: z.string().uuid(), title: z.string().nullable() })),
    other: z.number().int().nonnegative(),
  })
  .openapi("FileUsage");

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

// Inline-upload cap — single source of truth lives in
// `packages/shared/src/files-constants.ts` so the CLI and the engine
// can never drift on the size that splits inline from streamed
// uploads.
export { MAX_INLINE_BYTES } from "@shared/index.ts";

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
export type FileUsage = z.infer<typeof FileUsageSchema>;
export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;
