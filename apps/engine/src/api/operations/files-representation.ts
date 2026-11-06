import { z } from "@hono/zod-openapi";
import type { FileRow } from "../../files/service.ts";
import { fileReference } from "../../files/slug.ts";
import { catalogMetadataView } from "../catalog-metadata.ts";
import { FileIdSchema, type FileWire, toFileId } from "../files-schemas.ts";

export const FileIdParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
});

export function toFileWire(row: FileRow): FileWire {
  return {
    id: toFileId(row.id),
    status: row.status,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    scan_result: row.scan_result,
    created_by: row.created_by,
    creator: null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    replaced_at: row.replaced_at ? row.replaced_at.toISOString() : null,
    version: row.version,
    deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    slug: row.slug,
    reference: fileReference(row.slug),
    ...catalogMetadataView(row),
  };
}
