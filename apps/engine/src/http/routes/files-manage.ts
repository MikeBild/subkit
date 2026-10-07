import { createHash, randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, ne } from "drizzle-orm";
import { metadataChange } from "../../api/catalog-metadata.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FileIdSchema,
  FileSchema,
  FileUsageSchema,
  InlineUploadSchema,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
  UpdateFileSchema,
} from "../../api/files-schemas.ts";
import {
  AuditAction,
  actorType,
  auditAwait,
  bucketSize,
  FileRenamedMetadataSchema,
  FileReplacedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import { writeEvent } from "../../db/events.ts";
import {
  conversations,
  fileLinks,
  files,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "../../files/object-key.ts";
import { requireFileForTenant, storageKey } from "../../files/resolver.ts";
import type { ScanResult } from "../../files/scanner.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS } from "../../files/scanner.ts";
import { dagNamesFile } from "../../files/usage.ts";
import { logger } from "../../logging/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { toFileWire } from "./files.ts";

const TAG = "Files";

const FileIdParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
});

const notFound = { code: "not_found", message: "file not found" } as const;

async function scanBytes(
  bytes: Uint8Array,
  meta: { content_type: string | null; filename: string },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ScanResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ verdict: "timeout", engine: "timeout" }),
      SCANNER_TIMEOUT_SECONDS * 1000,
    );
  });
  try {
    return await Promise.race([getScanner().scan(streamFromBytes(bytes), meta), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerFileManageRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/files/:id/replace", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/usage", requireAnyPermission(["file:read"]));

  const renameRoute = createRoute({
    method: "patch",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: UpdateFileSchema } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: FileSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(renameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json(notFound, 404);
    }
    if (row.deleted_at) return c.json(notFound, 404);
    const metadata = metadataChange(row, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
    });
    const renamed = body.filename !== undefined && body.filename !== row.filename;
    if (!renamed && !metadata) return c.json(toFileWire(row), 200);
    const [updated] = await db
      .update(files)
      .set({
        ...(renamed ? { filename: body.filename } : {}),
        ...metadata,
        updated_at: new Date(),
      })
      .where(eq(files.id, row.id))
      .returning();
    if (renamed) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_RENAMED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          metadata: FileRenamedMetadataSchema.parse({
            file_id: row.id,
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
    }
    if (metadata) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.CATALOG_METADATA_UPDATED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          before: { description: row.description, category: row.category },
          after: {
            description:
              metadata.description === undefined ? row.description : metadata.description,
            category: metadata.category ?? row.category,
          },
          metadata: {
            ...(metadata.description_source
              ? { description_source: metadata.description_source }
              : {}),
            ...(metadata.category_source ? { category_source: metadata.category_source } : {}),
          },
        },
        db,
      );
    }
    return c.json(toFileWire(updated ?? row), 200);
  });

  const replaceRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/replace",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: InlineUploadSchema } } },
    },
    responses: {
      200: {
        description: "Replaced; the id and every reference to it are unchanged",
        content: { "application/json": { schema: FileSchema } },
      },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: {
        description: "duplicate_content",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
      422: {
        description: "scan_rejected",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(replaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json(notFound, 404);
    }
    if (row.deleted_at) return c.json(notFound, 404);

    const bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    if (bytes.byteLength === 0) return c.json({ code: "bad_input", message: "empty content" }, 400);
    if (bytes.byteLength > MAX_INLINE_BYTES)
      return c.json(
        { code: "too_large", message: `replacement exceeds ${MAX_INLINE_BYTES} bytes cap` },
        413,
      );

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 === row.sha256) return c.json(toFileWire(row), 200);
    const twin = await db
      .select({ id: files.id, filename: files.filename })
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, sha256), ne(files.id, row.id)))
      .limit(1);
    if (twin[0])
      return c.json(
        {
          code: "duplicate_content",
          message: "another stored file already has exactly this content",
          hint: `Use the existing file ${toFileId(twin[0].id)} instead.`,
        },
        409,
      );

    const key = buildObjectKey(tenant_id, randomUUID());
    await getObjectStore().put(key, bytes);
    const scan = await scanBytes(bytes, {
      content_type: body.content_type ?? null,
      filename: body.filename,
    });
    if (scan.verdict !== "clean") {
      try {
        await getObjectStore().delete(key);
      } catch {}
      return c.json(
        {
          code: "scan_rejected",
          message:
            scan.verdict === "timeout"
              ? "the content could not be checked in time; nothing was replaced"
              : "the content did not pass the scan; nothing was replaced",
        },
        422,
      );
    }

    const previousKey = storageKey(row.storage_uri);
    const now = new Date();
    const [updated] = await db
      .update(files)
      .set({
        content_type: body.content_type ?? null,
        size_bytes: bytes.byteLength,
        storage_uri: composeStorageUri(key),
        sha256,
        scan_result: scan.verdict,
        status: "ready",
        updated_at: now,
        replaced_at: now,
      })
      .where(eq(files.id, row.id))
      .returning();
    try {
      await getObjectStore().delete(previousKey);
    } catch (err) {
      logger.warn({
        module: "http.files",
        action: "replace.previous_object",
        msg: "replaced file's previous object was not removed",
        file_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_REPLACED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileReplacedMetadataSchema.parse({
          file_id: row.id,
          content_type: body.content_type ?? null,
          size_bytes_bucket: bucketSize(bytes.byteLength),
          sha256_prefix: sha256.slice(0, 16),
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    await writeEvent(db, {
      tenant_id,
      channel: "notification.emitted",
      type: "file.replaced",
      payload: { file_id: toFileId(row.id) },
    });
    return c.json(toFileWire(updated ?? row), 200);
  });

  const usageRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/usage",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: FileUsageSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(usageRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json(notFound, 404);
    }
    const usedBy = await db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
      .where(
        and(
          eq(workflows.tenant_id, tenant_id),
          isNull(workflows.deleted_at),
          dagNamesFile(workflowVersions.dag, toFileId(row.id), row.slug),
        ),
      )
      .orderBy(workflows.name);
    const links = await db
      .select({
        resource_type: fileLinks.resource_type,
        resource_id: fileLinks.resource_id,
        title: conversations.title,
      })
      .from(fileLinks)
      .leftJoin(
        conversations,
        and(
          eq(fileLinks.resource_type, "conversation"),
          eq(conversations.id, fileLinks.resource_id),
          eq(conversations.tenant_id, tenant_id),
        ),
      )
      .where(and(eq(fileLinks.tenant_id, tenant_id), eq(fileLinks.file_id, row.id)));
    const seen = new Set<string>();
    const conversationsUsing: Array<{ id: string; title: string | null }> = [];
    let other = 0;
    for (const link of links) {
      if (link.resource_type !== "conversation") {
        other += 1;
        continue;
      }
      if (seen.has(link.resource_id)) continue;
      seen.add(link.resource_id);
      conversationsUsing.push({ id: link.resource_id, title: link.title ?? null });
    }
    return c.json({ workflows: usedBy, conversations: conversationsUsing, other }, 200);
  });
}
