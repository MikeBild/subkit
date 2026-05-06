// Conversation attachments HTTP surface.
//
//   POST   /v1/conversations/:id/attachments              — upload (JSON body)
//   GET    /v1/conversations/:id/attachments              — list
//   GET    /v1/conversations/:id/attachments/:slug        — fetch meta + preview
//   DELETE /v1/conversations/:id/attachments/:slug        — delete
//
// The upload body is JSON (not multipart): { filename, content_type?,
// content, content_encoding? }. `content` is either raw text or base64
// when `content_encoding: "base64"`. This keeps the route compatible
// with any HTTP client (Hono, curl, sk-CLI) without requiring a
// multipart parser while giving us deterministic byte accounting.
//
// Storage: when `DATA_DIR` env is set and writable we persist under
// `${DATA_DIR}/attachments/<uuid>/<slug>` and store a `file://` URI.
// Otherwise we fall back to `memory://` — tests use the in-memory store
// directly via `putMemoryAttachment` (see conversations/attachments.ts).
//
// Audit: every upload + delete writes a `conversation.attachment_created`
// / `conversation.attachment_deleted` entry.

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import {
  clearMemoryAttachments as _clearMemoryAttachmentsUnused,
  putMemoryAttachment,
} from "../../conversations/index.ts";
import { conversationAttachments, conversations } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

void _clearMemoryAttachmentsUnused;

const IdParam = z.object({ id: z.string().uuid() });
const SlugParam = z.object({ id: z.string().uuid(), slug: z.string().min(1) });

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap
const PREVIEW_CHARS = 2000;

const UploadBody = z
  .object({
    filename: z.string().min(1).max(255),
    content_type: z.string().max(200).optional(),
    content: z.string(),
    content_encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .openapi("ConversationAttachmentUpload");

const AttachmentSchema = z
  .object({
    slug: z.string(),
    original_filename: z.string(),
    content_type: z.string().nullable(),
    size_bytes: z.number(),
    sha256: z.string(),
    preview: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("ConversationAttachment");

const ListResponse = z
  .object({ attachments: z.array(AttachmentSchema) })
  .openapi("ConversationAttachmentList");

function slugify(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const sanitised = stem.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitised.length === 0 ? `file-${Date.now().toString(36)}` : sanitised.slice(0, 48);
}

function isTextLike(ct: string | undefined): boolean {
  if (!ct) return true;
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("yaml") ||
    ct.includes("xml") ||
    ct.includes("x-www-form-urlencoded")
  );
}

async function storeContent(
  tenant_id: string,
  conversation_id: string,
  slug: string,
  bytes: Uint8Array,
): Promise<string> {
  const dataDir = process.env.DATA_DIR;
  if (dataDir && dataDir.length > 0) {
    const dir = path.join(dataDir, "attachments", tenant_id, conversation_id);
    try {
      await fs.mkdir(dir, { recursive: true });
      const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "_");
      const filePath = path.join(dir, `${safeSlug}-${randomUUID().slice(0, 8)}`);
      await fs.writeFile(filePath, bytes);
      return `file://${filePath}`;
    } catch (err) {
      logger.warn({
        module: "http.conversation_attachments",
        action: "disk_store_failed",
        msg: "failed to write attachment to DATA_DIR — falling back to memory://",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Fallback: memory store keyed by (conversation_id:slug). Works out
  // of the box for tests; real deployments should set DATA_DIR.
  const key = `${conversation_id}:${slug}`;
  const text = new TextDecoder().decode(bytes);
  putMemoryAttachment(key, text);
  return `memory://${key}`;
}

async function conversationExists(
  db: AppEnv["Variables"]["db"],
  tenant_id: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)))
    .limit(1);
  return Boolean(row);
}

export function registerConversationAttachmentRoutes(app: OpenAPIHono<AppEnv>): void {
  // Permission gate lives at the app mount point via `app.use`; Hono's
  // route-level middleware doesn't compose with OpenAPIHono's createRoute
  // type inference here.
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
      body: {
        content: { "application/json": { schema: UploadBody } },
      },
    },
    responses: {
      201: {
        description: "Uploaded",
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

    const bytes =
      body.content_encoding === "base64"
        ? Uint8Array.from(Buffer.from(body.content, "base64"))
        : new TextEncoder().encode(body.content);
    if (bytes.byteLength > MAX_BYTES) {
      return c.json(
        { code: "too_large", message: `attachment exceeds ${MAX_BYTES} bytes cap` },
        413,
      );
    }

    const slug = slugify(body.filename);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storage_uri = await storeContent(tenant_id, id, slug, bytes);

    const ct = body.content_type ?? null;
    const preview = isTextLike(ct ?? undefined)
      ? new TextDecoder().decode(bytes).slice(0, PREVIEW_CHARS)
      : null;

    const [row] = await db
      .insert(conversationAttachments)
      .values({
        tenant_id,
        conversation_id: id,
        slug,
        original_filename: body.filename,
        content_type: ct,
        size_bytes: bytes.byteLength,
        storage_uri,
        sha256,
        preview,
      })
      .onConflictDoUpdate({
        target: [conversationAttachments.conversation_id, conversationAttachments.slug],
        set: {
          original_filename: body.filename,
          content_type: ct,
          size_bytes: bytes.byteLength,
          storage_uri,
          sha256,
          preview,
        },
      })
      .returning();
    if (!row) {
      return c.json({ code: "internal_error", message: "insert failed" }, 400);
    }

    await auditAwait(
      {
        tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
        actor_id: principal.id,
        action: AuditAction.CONVERSATION_ATTACHMENT_CREATED,
        resource_type: "conversation_attachment",
        resource_id: row.id,
        result: "success",
        metadata: {
          conversation_id: id,
          slug,
          content_type: ct,
          size_bytes: bytes.byteLength,
        },
      },
      db,
    );

    return c.json(
      {
        slug: row.slug,
        original_filename: row.original_filename,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        preview: row.preview,
        created_at: row.created_at.toISOString(),
      },
      201,
    );
  });

  const listRoute = createRoute({
    method: "get",
    path: "/v1/conversations/{id}/attachments",
    tags: ["Conversations"],
    security: [{ bearerAuth: [] }],
    request: { params: IdParam },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: ListResponse } },
      },
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
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.tenant_id, principal.tenant_id),
          eq(conversationAttachments.conversation_id, id),
        ),
      )
      .orderBy(desc(conversationAttachments.created_at));
    return c.json(
      {
        attachments: rows.map((r) => ({
          slug: r.slug,
          original_filename: r.original_filename,
          content_type: r.content_type,
          size_bytes: r.size_bytes,
          sha256: r.sha256,
          preview: r.preview,
          created_at: r.created_at.toISOString(),
        })),
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
      204: { description: "Deleted" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });
  app.openapi(deleteRoute, async (c) => {
    const { id, slug } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const [row] = await db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.tenant_id, principal.tenant_id),
          eq(conversationAttachments.conversation_id, id),
          eq(conversationAttachments.slug, slug),
        ),
      )
      .limit(1);
    if (!row) {
      return c.json({ code: "not_found", message: "attachment not found" }, 404);
    }
    await db.delete(conversationAttachments).where(eq(conversationAttachments.id, row.id));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
        actor_id: principal.id,
        action: AuditAction.CONVERSATION_ATTACHMENT_DELETED,
        resource_type: "conversation_attachment",
        resource_id: row.id,
        result: "success",
        metadata: { conversation_id: id, slug },
      },
      db,
    );
    return c.body(null, 204);
  });
}
