import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FileRefSchema,
  FileSchema,
  type FileWire,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
} from "../../api/files-schemas.ts";
import {
  AuditAction,
  actorType,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  FileLinkAddedMetadataSchema,
  FileLinkRemovedMetadataSchema,
  FileScanCompletedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { conversations, fileLinks, files } from "../../db/schema/index.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { requireFileForTenant } from "../../files/resolver.ts";
import { fileReference, slugifyFilename } from "../../files/slug.ts";
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

function linkSlug(row: typeof files.$inferSelect): string {
  return row.slug ?? slugifyFilename(row.filename);
}

function toAttachmentWire(row: typeof files.$inferSelect, slug: string): AttachmentWire {
  return {
    id: toFileId(row.id),
    status: row.status,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    scan_result: row.scan_result,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    slug,
    reference: fileReference(slug),
  };
}

async function conversationExists(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)))
    .limit(1);
  return Boolean(row);
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
      let fileRow: typeof files.$inferSelect;
      try {
        fileRow = await requireFileForTenant(db, tenant_id, fid_uuid);
      } catch {
        return c.json({ code: "not_found", message: "file not found" }, 404);
      }
      const slug = linkSlug(fileRow);
      await db
        .insert(fileLinks)
        .values({
          tenant_id,
          file_id: fileRow.id,
          resource_type: "conversation",
          resource_id: id,
          slug,
          role: "attachment",
        })
        .onConflictDoNothing();
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_LINK_ADDED,
          resource_type: "file",
          resource_id: fileRow.id,
          result: "success",
          metadata: FileLinkAddedMetadataSchema.parse({
            file_id: fileRow.id,
            resource_type: "conversation",
            resource_id: id,
            slug,
            request_source: readRequestSource(c),
            source: "conversation_attachments",
          }),
        },
        db,
      );
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
    const { row, dedup, scan } = await persistInlineUpload(db, {
      tenant_id,
      actor_id: principal.id,
      filename,
      content_type,
      bytes,
    });
    if (dedup) {
      await recordFilesDedupSeen(db, tenant_id);
    }
    const slug = linkSlug(row);
    await db
      .insert(fileLinks)
      .values({
        tenant_id,
        file_id: row.id,
        resource_type: "conversation",
        resource_id: id,
        slug,
        role: "attachment",
      })
      .onConflictDoNothing();

    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_CREATED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileCreatedMetadataSchema.parse({
          file_id: row.id,
          filename,
          content_type,
          size_bytes_bucket: bucketSize(bytes.byteLength),
          sha256_prefix: row.sha256 ? row.sha256.slice(0, 16) : undefined,
          dedup,
          request_source: readRequestSource(c),
          source: "conversation_attachments",
        }),
      },
      db,
    );
    if (scan) {
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_SCAN_COMPLETED,
          resource_type: "file",
          resource_id: row.id,
          result:
            scan.verdict === "clean" ? "success" : scan.verdict === "timeout" ? "error" : "denied",
          metadata: FileScanCompletedMetadataSchema.parse({
            file_id: row.id,
            verdict: scan.verdict,
            engine: scan.engine,
            signature: scan.signature,
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
    }
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_LINK_ADDED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileLinkAddedMetadataSchema.parse({
          file_id: row.id,
          resource_type: "conversation",
          resource_id: id,
          slug,
          request_source: readRequestSource(c),
          source: "conversation_attachments",
        }),
      },
      db,
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
    const rows = await db
      .select({ link: fileLinks, file: files })
      .from(fileLinks)
      .innerJoin(files, eq(files.id, fileLinks.file_id))
      .where(
        and(
          eq(fileLinks.tenant_id, principal.tenant_id),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, id),
        ),
      )
      .orderBy(desc(fileLinks.created_at));
    return c.json(
      {
        attachments: rows.map((r) => toAttachmentWire(r.file, r.link.slug ?? linkSlug(r.file))),
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
    const [link] = await db
      .select()
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, principal.tenant_id),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, id),
          eq(fileLinks.slug, slug),
        ),
      )
      .limit(1);
    if (!link) {
      return c.json({ code: "not_found", message: "attachment not found" }, 404);
    }
    await db.delete(fileLinks).where(eq(fileLinks.id, link.id));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_LINK_REMOVED,
        resource_type: "file",
        resource_id: link.file_id,
        result: "success",
        metadata: FileLinkRemovedMetadataSchema.parse({
          file_id: link.file_id,
          resource_type: "conversation",
          resource_id: id,
          slug,
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    return c.body(null, 204);
  });
}
