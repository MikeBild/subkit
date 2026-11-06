import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FileRefSchema,
  FileSchema,
  type FileWire,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
} from "../../api/files-schemas.ts";
import { toFileWire } from "../../api/operations/files-representation.ts";
import { actorType, readRequestSource } from "../../audit/index.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { FileLinkError, linkStoredFile } from "../../files/links.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { type FileRow, requireFileForTenant } from "../../files/resolver.ts";
import {
  auditConversationAttachmentStored,
  conversationExists,
  listConversationAttachments,
  unlinkConversationAttachment,
} from "../../files/service.ts";
import { fileReference, slugifyFilename } from "../../files/slug.ts";
import {
  isPackageArchive,
  markStoredPackageArchive,
  PACKAGE_CONTENT_TYPE,
} from "../../identity/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const IdParam = z.object({ id: z.string().uuid() });
const SlugParam = z.object({ id: z.string().uuid(), slug: z.string().min(1) });

const UploadBody = z
  .union([
    FileRefSchema,
    z.object({
      filename: z.string().min(1).max(255),
      content_type: z.string().max(200).optional(),
      content_base64: z.string().min(1),
    }),
  ])
  .openapi("ConversationAttachmentUpload");

const AttachmentSchema = FileSchema.extend({
  slug: z.string(),
}).openapi("ConversationAttachment");
type AttachmentWire = FileWire & { slug: string };

const ListResponse = z
  .object({ attachments: z.array(AttachmentSchema) })
  .openapi("ConversationAttachmentList");

function linkSlug(row: FileRow): string {
  return row.slug ?? slugifyFilename(row.filename);
}

function toAttachmentWire(row: FileRow, slug: string): AttachmentWire {
  return { ...toFileWire(row), slug, reference: fileReference(slug) };
}

export function registerConversationAttachmentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/conversations/:id/attachments*", async (c, next) => {
    if (c.req.method === "GET") {
      return requireAnyPermission(["conversation:read", "workflow:read"])(c, next);
    }
    return requireAnyPermission(["conversation:write", "workflow:write"])(c, next);
  });

  const uploadRoute = createRoute({
    method: "post",
    path: "/v1/conversations/{id}/attachments",
    tags: ["Conversations"],
    security: [{ bearerAuth: [] }],
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: UploadBody } } },
    },
    responses: {
      201: {
        description: "Linked",
        content: { "application/json": { schema: AttachmentSchema } },
      },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(uploadRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;

    if (!(await conversationExists(db, tenant_id, id))) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }

    if ("$file" in body) {
      const fid_uuid = parseFileIdOrThrow(body.$file);
      let fileRow: FileRow;
      try {
        fileRow = await requireFileForTenant(db, tenant_id, fid_uuid);
      } catch {
        return c.json({ code: "not_found", message: "file not found" }, 404);
      }
      const slug = linkSlug(fileRow);
      const linked = await linkStoredFile(
        db,
        {
          tenant_id,
          file_id: fileRow.id,
          resource_type: "conversation",
          resource_id: id,
          slug,
          role: "attachment",
        },
        {
          actor_type: actorType(principal),
          actor_id: principal.id,
          request_source: readRequestSource(c) ?? "api",
          source: "conversation_attachments",
          allowed_statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
        },
      ).catch((error: unknown) => {
        if (error instanceof FileLinkError)
          return error.code === "file_unavailable"
            ? c.json({ code: "not_found", message: "File is no longer available." }, 404)
            : c.json(
                { code: "conflict", message: "Attachment link changed; reload and retry." },
                400,
              );
        throw error;
      });
      if (linked instanceof Response) return linked;

      return c.json(toAttachmentWire(fileRow, slug), 201);
    }

    const filename = body.filename;
    const content_type = body.content_type ?? null;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    } catch {
      return c.json({ code: "bad_input", message: "invalid base64" }, 400);
    }
    if (bytes.byteLength === 0) {
      return c.json({ code: "bad_input", message: "empty content" }, 400);
    }
    if (bytes.byteLength > MAX_INLINE_BYTES) {
      return c.json(
        { code: "too_large", message: `attachment exceeds ${MAX_INLINE_BYTES} bytes cap` },
        413,
      );
    }
    const isPackage = await isPackageArchive(bytes);
    const stored = await persistInlineUpload(db, {
      tenant_id,
      actor_id: principal.id,
      filename,
      content_type: isPackage ? PACKAGE_CONTENT_TYPE : content_type,
      bytes,
    });
    const { dedup, scan } = stored;
    const row =
      isPackage && stored.row.content_type !== PACKAGE_CONTENT_TYPE
        ? ((await markStoredPackageArchive(db, tenant_id, stored.row.id)) ?? stored.row)
        : stored.row;
    if (dedup) {
      await recordFilesDedupSeen(db, tenant_id);
    }
    const slug = linkSlug(row);
    const linked = await linkStoredFile(
      db,
      {
        tenant_id,
        file_id: row.id,
        resource_type: "conversation",
        resource_id: id,
        slug,
        role: "attachment",
      },
      {
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: readRequestSource(c) ?? "api",
        source: "conversation_attachments",
        allowed_statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
      },
    ).catch((error: unknown) => {
      if (error instanceof FileLinkError)
        return error.code === "file_unavailable"
          ? c.json({ code: "not_found", message: "File is no longer available." }, 404)
          : c.json(
              { code: "conflict", message: "Attachment link changed; reload and retry." },
              400,
            );
      throw error;
    });
    if (linked instanceof Response) return linked;

    await auditConversationAttachmentStored(
      db,
      { principal, request_source: readRequestSource(c) },
      { row, filename, size_bytes: bytes.byteLength, dedup, scan },
    );

    return c.json(toAttachmentWire(row, slug), 201);
  });

  const listRoute = createRoute({
    method: "get",
    path: "/v1/conversations/{id}/attachments",
    tags: ["Conversations"],
    security: [{ bearerAuth: [] }],
    request: { params: IdParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(listRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    if (!(await conversationExists(db, principal.tenant_id, id))) {
      return c.json({ code: "not_found", message: "conversation not found" }, 404);
    }
    const rows = await listConversationAttachments(db, principal.tenant_id, id);
    return c.json(
      {
        attachments: rows.map((r) => toAttachmentWire(r.file, r.link_slug ?? linkSlug(r.file))),
      },
      200,
    );
  });

  const deleteRoute = createRoute({
    method: "delete",
    path: "/v1/conversations/{id}/attachments/{slug}",
    tags: ["Conversations"],
    security: [{ bearerAuth: [] }],
    request: { params: SlugParam },
    responses: {
      204: { description: "Unlinked" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(deleteRoute, async (c) => {
    const { id, slug } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const unlinked = await unlinkConversationAttachment(
      db,
      { principal, request_source: readRequestSource(c) },
      id,
      slug,
    );
    if (!unlinked) {
      return c.json({ code: "not_found", message: "attachment not found" }, 404);
    }
    return c.body(null, 204);
  });
}
