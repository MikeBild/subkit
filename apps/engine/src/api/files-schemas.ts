import { z } from "@hono/zod-openapi";
import { FILE_LINK_RESOURCE_TYPES } from "@shared/index.ts";

export const FileIdSchema = z
  .string()
  .regex(/^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .openapi("FileId");

export function parseFileId(wire: string): string | null {
  if (!wire.startsWith("fid_")) return null;
  return wire.slice("fid_".length);
}

export function parseFileIdOrThrow(wire: string): string {
  const uuid = parseFileId(wire);
  if (uuid === null) {
    throw new Error(`invalid file id (missing fid_ prefix): ${wire}`);
  }
  return uuid;
}

export function toFileId(uuid: string): string {
  return `fid_${uuid}`;
}

export const FileRefSchema = z.object({ $file: FileIdSchema }).openapi("FileRef");

export const FileStatusSchema = z
  .enum(["pending", "uploading", "scanning", "ready", "failed", "expired"])
  .openapi("FileStatus");

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
    slug: z.string().nullable(),
    reference: z.string().nullable(),
  })
  .openapi("File");

export const InlineUploadSchema = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().max(200).optional(),
    content_base64: z.string().min(1),
  })
  .openapi("InlineUpload");

const SHA256_REGEX = /^[0-9a-f]{64}$/;

export const MAX_STREAM_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_PRESIGN_BYTES = MAX_STREAM_UPLOAD_BYTES;

export const MAX_FINALIZE_VERIFY_BYTES = MAX_STREAM_UPLOAD_BYTES;

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
    sha256: z.string().regex(SHA256_REGEX).optional(),
  })
  .openapi("BatchCreateEntry");

export const BatchCreateRequestSchema = z
  .object({ files: z.array(BatchCreateEntrySchema).min(1).max(100) })
  .openapi("BatchCreateRequest");

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

export const FinalizeRequestSchema = z
  .object({ sha256: z.string().regex(SHA256_REGEX) })
  .openapi("FinalizeRequest");

export { FILE_LINK_RESOURCE_TYPES };

export const FileLinkResourceTypeSchema = z
  .enum(FILE_LINK_RESOURCE_TYPES)
  .openapi("FileLinkResourceType");

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

export const FileStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    by_status: z.record(z.string(), z.number().int().nonnegative()),
    by_size_bucket: z.record(z.string(), z.number().int().nonnegative()),
    dedup_hits: z.number().int().nonnegative(),
    scan_verdicts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .openapi("FileStats");

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

export const RenameFileSchema = z
  .object({ filename: z.string().trim().min(1).max(255) })
  .openapi("RenameFile");

export const FileUsageSchema = z
  .object({
    workflows: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
    conversations: z.array(z.object({ id: z.string().uuid(), title: z.string().nullable() })),
    other: z.number().int().nonnegative(),
  })
  .openapi("FileUsage");

export { MAX_INLINE_BYTES } from "@shared/index.ts";

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
