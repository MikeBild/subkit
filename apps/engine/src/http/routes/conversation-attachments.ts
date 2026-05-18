// Conversation attachments HTTP surface — thin wrapper over the
// unified `files` + `file_links` resource.
//
//   POST   /v1/conversations/:id/attachments              — upload (inline JSON body)
//   GET    /v1/conversations/:id/attachments              — list linked files
//   DELETE /v1/conversations/:id/attachments/:slug        — unlink (does NOT delete the file)
//
// URL shape is preserved for backwards compatibility with operator
// tooling that POSTs to the legacy path. Under the hood every call
// goes through the canonical `files` + `file_links` tables:
//
//   - POST decodes the JSON body, dedups + inserts a `files` row
//     (sha256-scoped to the tenant), then attaches a `file_links` row
//     pointing the file at the conversation under the derived slug.
//     Emits `FILE_CREATED` + `FILE_SCAN_COMPLETED` + `FILE_LINK_ADDED`
//     symmetric with the canonical `/v1/files/inline` route. The legacy
//     `conversation.attachment_*` audit actions are removed; SIEM
//     consumers filter on the new `file.*` vocabulary.
//   - GET joins `file_links` with `files` filtered by the conversation.
//   - DELETE removes the `file_links` row only — the `files` row stays
//     for any other conversation / resource that still references it,
//     and the cleanup cron eventually GCs orphans.
//
// Permission asymmetry vs the canonical /v1/files/* surface: this
// wrapper gates on `conversation:write`/`conversation:read`, while
// the canonical surface requires `file:write`/`file:read`. A portal-
// scoped user that holds only conversation permissions can still
// upload through this route. This is intentional — the wrapper exists
// so portal-only personas keep their attachment ergonomics without
// having to grant the broader file vocabulary.
//
// Body schema: either an `InlineUpload` ({ filename, content_base64 })
// or a `{ $file: "fid_..." }` ref pointing at an existing file the
// caller already uploaded via `/v1/files/inline`. The legacy `content`
// + `content_encoding` fields are accepted as a temporary alias for
// `content_base64` (utf8 → base64 server-side) so callers mid-migration
// keep working without a coordinated client bump.

import { createHash, randomUUID } from "node:crypto";
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
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  FileLinkAddedMetadataSchema,
  FileLinkRemovedMetadataSchema,
  FileScanCompletedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { conversations, fileLinks, files } from "../../db/schema/index.ts";
import { requireFileForTenant } from "../../files/resolver.ts";
import { getScanner } from "../../files/scanner.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const IdParam = z.object({ id: z.string().uuid() });
const SlugParam = z.object({ id: z.string().uuid(), slug: z.string().min(1) });

/** Accepts either an inline JSON+base64 upload, an inline JSON+utf8
 *  upload (legacy), or an existing-file ref. The route resolves any
 *  of these to a canonical `files` row + `file_links` row. */
const UploadBody = z
  .union([
    FileRefSchema,
    z.object({
      filename: z.string().min(1).max(255),
      content_type: z.string().max(200).optional(),
      content_base64: z.string().min(1),
    }),
    // Legacy shape — `content` + optional `content_encoding`. Kept so
    // callers mid-migration keep working without a coordinated client
    // bump. Removed once external tooling has flipped to
    // `content_base64`.
    z.object({
      filename: z.string().min(1).max(255),
      content_type: z.string().max(200).optional(),
      content: z.string(),
      content_encoding: z.enum(["utf8", "base64"]).default("utf8"),
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

function slugify(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").toLowerCase();
  const sanitised = stem.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitised.length === 0 ? `file-${Date.now().toString(36)}` : sanitised.slice(0, 48);
}

/** Wire-shape projection — extends the canonical `FileSchema` with the
 *  per-conversation slug that the chat-text rewriter resolves. */
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
  };
}

function buildObjectKey(tenant_id: string, file_uuid: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${tenant_id}/${yyyy}/${mm}/${dd}/${file_uuid}`;
}

function composeStorageUri(key: string): string {
  const cfg = getConfig().storage;
  if (cfg.files.backend === "s3") return `s3://${cfg.files.bucket}/${key}`;
  return `local://${key}`;
}

function streamFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

async function conversationExists(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)))
    .limit(1);
  return Boolean(row);
}

/** Scanner output exposed to the caller so it can emit a
 *  `FILE_SCAN_COMPLETED` audit row symmetric with the canonical
 *  `/v1/files/inline` route. `null` is returned on the dedup branch —
 *  no fresh scan ran, no audit row to emit. */
interface PersistedScan {
  verdict: string;
  engine: string;
  signature: string | null;
}

/** Find or create a `files` row for the given bytes. Returns the row
 *  along with a flag indicating whether dedup short-circuited the
 *  upload and (for fresh inserts) the scanner verdict so the caller
 *  can emit the symmetric `FILE_SCAN_COMPLETED` audit row. Mirrors the
 *  dedup logic in `POST /v1/files/inline`. */
async function persistFileBytes(
  db: Db,
  params: {
    tenant_id: string;
    actor_id: string | null;
    filename: string;
    content_type: string | null;
    bytes: Uint8Array;
  },
): Promise<{ row: typeof files.$inferSelect; dedup: boolean; scan: PersistedScan | null }> {
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");
  const existing = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, params.tenant_id), eq(files.sha256, sha256)))
    .limit(1);
  if (existing[0]) return { row: existing[0], dedup: true, scan: null };

  const file_uuid = randomUUID();
  const key = buildObjectKey(params.tenant_id, file_uuid);
  const storage_uri = composeStorageUri(key);
  await getObjectStore().put(key, params.bytes);
  const scan = await getScanner().scan(streamFromBytes(params.bytes), {
    content_type: params.content_type,
    filename: params.filename,
  });
  const status = scan.verdict === "clean" ? "ready" : "failed";
  const scanInfo: PersistedScan = {
    verdict: scan.verdict,
    engine: scan.engine,
    signature: scan.signature ?? null,
  };
  try {
    const inserted = await db
      .insert(files)
      .values({
        id: file_uuid,
        tenant_id: params.tenant_id,
        status,
        filename: params.filename,
        content_type: params.content_type,
        size_bytes: params.bytes.byteLength,
        storage_uri,
        sha256,
        scan_result: scan.verdict,
        created_by: params.actor_id,
      })
      .returning();
    const row = inserted[0];
    if (row) return { row, dedup: false, scan: scanInfo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("files_tenant_sha256_uq") || msg.includes("duplicate key")) {
      const again = await db
        .select()
        .from(files)
        .where(and(eq(files.tenant_id, params.tenant_id), eq(files.sha256, sha256)))
        .limit(1);
      if (again[0]) {
        try {
          await getObjectStore().delete(key);
        } catch {
          /* best-effort */
        }
        return { row: again[0], dedup: true, scan: null };
      }
    }
    throw err;
  }
  throw new Error("files insert returned no row");
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

    // Branch 1: `$file` ref — caller already uploaded via /v1/files/*.
    // We just link it into the conversation.
    if ("$file" in body) {
      // body.$file already validated by Zod (`FileIdSchema` via `FileRefSchema`);
      // `OrThrow` asserts the invariant — a null here indicates a Zod regression.
      const fid_uuid = parseFileIdOrThrow(body.$file);
      let fileRow: typeof files.$inferSelect;
      try {
        fileRow = await requireFileForTenant(db, tenant_id, fid_uuid);
      } catch {
        return c.json({ code: "not_found", message: "file not found" }, 404);
      }
      const slug = slugify(fileRow.filename);
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
          actor_type: principal.kind === "user" ? "user" : "system_account",
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
          }),
        },
        db,
      );
      return c.json(toAttachmentWire(fileRow, slug), 201);
    }

    // Branch 2: inline upload (either `content_base64` or legacy `content`/`content_encoding`).
    let bytes: Uint8Array;
    let filename: string;
    let content_type: string | null;
    if ("content_base64" in body) {
      filename = body.filename;
      content_type = body.content_type ?? null;
      try {
        bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
      } catch {
        return c.json({ code: "bad_input", message: "invalid base64" }, 400);
      }
    } else {
      filename = body.filename;
      content_type = body.content_type ?? null;
      bytes =
        body.content_encoding === "base64"
          ? Uint8Array.from(Buffer.from(body.content, "base64"))
          : new TextEncoder().encode(body.content);
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
    const { row, dedup, scan } = await persistFileBytes(db, {
      tenant_id,
      actor_id:
        principal.kind === "user" || principal.kind === "system_account" ? principal.id : null,
      filename,
      content_type,
      bytes,
    });
    const slug = slugify(filename);
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

    // Audit the create + scan + link as three separate rows — mirrors
    // the canonical `/v1/files/inline` route. `FILE_SCAN_COMPLETED`
    // fires only on fresh inserts (dedup hits short-circuited before
    // the scanner ran); skipping it on dedup matches the canonical
    // route which never re-scans an existing row. A downstream SIEM
    // query on `FILE_CREATED` + `FILE_SCAN_COMPLETED` therefore returns
    // a consistent shape regardless of which entry point landed the
    // bytes.
    await auditAwait(
      {
        tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
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
        }),
      },
      db,
    );
    if (scan) {
      await auditAwait(
        {
          tenant_id,
          actor_type: principal.kind === "user" ? "user" : "system_account",
          actor_id: principal.id,
          action: AuditAction.FILE_SCAN_COMPLETED,
          resource_type: "file",
          resource_id: row.id,
          // `timeout` is an operational failure (scanner backend slow / wedged),
          // not a security verdict — log it as `error`. Mirrors the
          // canonical files.ts inline handler.
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
        actor_type: principal.kind === "user" ? "user" : "system_account",
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
        attachments: rows.map((r) =>
          toAttachmentWire(r.file, r.link.slug ?? slugify(r.file.filename)),
        ),
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
    // Unlinking does NOT delete the file row — that's the cleanup
    // cron's job once the row is orphaned (no remaining `file_links`).
    // Emit `FILE_LINK_REMOVED` so the audit ledger keeps a symmetric
    // attach/detach pair (paired with `FILE_LINK_ADDED` emitted by the
    // POST handler above and by the canonical `/v1/files/:id/links`
    // route).
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind === "user" ? "user" : "system_account",
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
