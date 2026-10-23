import { createHash, randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Context } from "hono";
import { DescriptionAcceptanceError, metadataChange } from "../../api/catalog-metadata.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  FILE_VERSION_RETENTION,
  FileIdSchema,
  FileSchema,
  FileUsageSchema,
  FileVersionListSchema,
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
  FileDownloadedMetadataSchema,
  FileRenamedMetadataSchema,
  readRequestSource,
} from "../../audit/index.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import type { Db } from "../../db/client.ts";
import {
  connectors,
  conversations,
  executions,
  fileLinks,
  files,
  knowledgeSources,
  skills,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "../../files/object-key.ts";
import { requireFileForTenant, storageKey } from "../../files/resolver.ts";
import type { ScanResult } from "../../files/scanner.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS } from "../../files/scanner.ts";
import { dagNamesFile } from "../../files/usage.ts";
import {
  DuplicateFileContentError,
  findFileVersion,
  listFileVersions,
  type NextContent,
  replaceFileContent,
} from "../../files/versions.ts";
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
const versionNotFound = { code: "not_found", message: "file version not found" } as const;

const FileVersionParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
  version: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: "version", in: "path" }, type: "integer" }),
});

async function liveFile(db: Db, tenantId: string, id: string) {
  try {
    const row = await requireFileForTenant(db, tenantId, parseFileIdOrThrow(id));
    return row.deleted_at ? null : row;
  } catch {
    return null;
  }
}

async function findTwin(db: Db, tenantId: string, sha256: string, fileId: string) {
  const [twin] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.tenant_id, tenantId), eq(files.sha256, sha256), ne(files.id, fileId)))
    .limit(1);
  return twin?.id ?? null;
}

function duplicate(twinId: string) {
  return {
    code: "duplicate_content",
    message: "another stored file already has exactly this content",
    hint: `Use the existing file ${toFileId(twinId)} instead.`,
  };
}

async function discardObject(key: string) {
  try {
    await getObjectStore().delete(key);
  } catch (err) {
    logger.warn({
      module: "http.files",
      action: "replace.discard_object",
      msg: "unused replacement object was not removed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function applyContent(
  c: Context<AppEnv>,
  fileId: string,
  key: string,
  content: NextContent,
): Promise<
  | { kind: "replaced" | "unchanged"; row: typeof files.$inferSelect }
  | { kind: "not_found" }
  | { kind: "duplicate"; twinId: string }
> {
  const principal = requireAuth(c);
  try {
    const result = await replaceFileContent(c.get("db"), {
      tenantId: principal.tenant_id,
      fileId,
      actor: {
        kind: actorType(principal) === "user" ? "user" : "system_account",
        id: principal.id,
      },
      content,
      requestSource: readRequestSource(c),
    });
    if (result.kind !== "replaced") await discardObject(key);
    return result;
  } catch (err) {
    await discardObject(key);
    if (err instanceof DuplicateFileContentError) return { kind: "duplicate", twinId: err.twinId };
    throw err;
  }
}

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
  app.use("/v1/files/:id/versions", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/versions/:version/content", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/versions/:version/restore", requireAnyPermission(["file:write"]));
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
      400: {
        description: "Invalid description acceptance",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "The reviewed description changed",
        content: { "application/json": { schema: ErrorSchema } },
      },
      200: { description: "Updated", content: { "application/json": { schema: FileSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(renameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    return db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, principal.tenant_id);
      let row: typeof files.$inferSelect;
      try {
        const fid = parseFileIdOrThrow(id);
        const uuid = fid.startsWith("fid_") ? fid.slice(4) : fid;
        const [found] = await tx
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, principal.tenant_id), eq(files.id, uuid)))
          .for("update")
          .limit(1);
        if (!found) return c.json(notFound, 404);
        row = found;
      } catch {
        return c.json(notFound, 404);
      }
      if (row.deleted_at) return c.json(notFound, 404);
      const metadata = metadataChange(row, {
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.accept_description !== undefined
          ? { accept_description: body.accept_description }
          : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
      });
      const renamed = body.filename !== undefined && body.filename !== row.filename;
      if (!renamed && !metadata) return c.json(toFileWire(row), 200);
      const [updated] = await tx
        .update(files)
        .set({
          ...(renamed ? { filename: body.filename } : {}),
          ...metadata,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(files.tenant_id, principal.tenant_id),
            eq(files.id, row.id),
            isNull(files.deleted_at),
            ...(body.accept_description && typeof body.description === "string"
              ? [eq(files.description, body.description)]
              : []),
          ),
        )
        .returning();
      if (!updated && body.accept_description)
        throw new DescriptionAcceptanceError("description_changed");
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
          tx,
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
              category: updated?.category ?? row.category,
            },
            metadata: {
              request_source: readRequestSource(c),
              ...(metadata.description_source
                ? { description_source: metadata.description_source }
                : {}),
              ...(metadata.category_source ? { category_source: metadata.category_source } : {}),
            },
          },
          tx,
        );
      }
      return c.json(toFileWire(updated ?? row), 200);
    });
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
    const row = await liveFile(db, tenant_id, id);
    if (!row) return c.json(notFound, 404);

    const bytes = Uint8Array.from(Buffer.from(body.content_base64, "base64"));
    if (bytes.byteLength === 0) return c.json({ code: "bad_input", message: "empty content" }, 400);
    if (bytes.byteLength > MAX_INLINE_BYTES)
      return c.json(
        { code: "too_large", message: `replacement exceeds ${MAX_INLINE_BYTES} bytes cap` },
        413,
      );

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 === row.sha256 && body.filename === row.filename)
      return c.json(toFileWire(row), 200);
    const twin = await findTwin(db, tenant_id, sha256, row.id);
    if (twin) return c.json(duplicate(twin), 409);

    const key = buildObjectKey(tenant_id, randomUUID());
    await getObjectStore().put(key, bytes);
    const scan = await scanBytes(bytes, {
      content_type: body.content_type ?? null,
      filename: body.filename,
    });
    if (scan.verdict !== "clean") {
      await discardObject(key);
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
    const result = await applyContent(c, row.id, key, {
      filename: body.filename,
      content_type: body.content_type ?? null,
      size_bytes: bytes.byteLength,
      sha256,
      storage_uri: composeStorageUri(key),
      scan_result: scan.verdict,
      restored_from: null,
    });
    if (result.kind === "duplicate") return c.json(duplicate(result.twinId), 409);
    if (result.kind === "not_found") return c.json(notFound, 404);
    return c.json(toFileWire(result.row), 200);
  });

  const versionsRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/versions",
    tags: [TAG],
    summary: "List a file's content versions, newest first",
    description: `The current content and every earlier content kept after a replace or restore, newest first. \`current\` marks the content the file serves now. The newest ${FILE_VERSION_RETENTION} earlier versions are kept; deleting the file removes all of them.`,
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: FileVersionListSchema } },
      },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(versionsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const row = await liveFile(db, principal.tenant_id, id);
    if (!row) return c.json(notFound, 404);
    return c.json({ items: await listFileVersions(db, principal.tenant_id, row) }, 200);
  });

  const versionContentRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/versions/{version}/content",
    tags: [TAG],
    summary: "Download one content version of a file",
    security: [{ bearerAuth: [] }],
    request: { params: FileVersionParam },
    responses: {
      200: { description: "OK" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(versionContentRoute, async (c) => {
    const { id, version } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const row = await liveFile(db, principal.tenant_id, id);
    if (!row) return c.json(notFound, 404);
    const source =
      version === row.version
        ? row
        : await findFileVersion(db, principal.tenant_id, row.id, version);
    if (!source) return c.json(versionNotFound, 404);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_DOWNLOADED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileDownloadedMetadataSchema.parse({
          file_id: row.id,
          content_type: source.content_type,
          size_bytes_bucket: bucketSize(source.size_bytes),
          version,
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    const iterable = await getObjectStore().openRead(storageKey(source.storage_uri));
    const iterator = iterable[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await iterator.return?.(reason);
        } catch {}
      },
    });
    return c.body(stream, 200, {
      ...storedContentHeaders(source.content_type, source.filename),
      "content-length": String(source.size_bytes),
    });
  });

  const restoreRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/versions/{version}/restore",
    tags: [TAG],
    summary: "Make an earlier content version the file's content again",
    description:
      "Restores the content of an earlier version as a new version. The content it replaces stays in the history, so a restore can be undone the same way. The id and every reference stay unchanged.",
    security: [{ bearerAuth: [] }],
    request: { params: FileVersionParam },
    responses: {
      200: {
        description: "Restored as the newest version",
        content: { "application/json": { schema: FileSchema } },
      },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: {
        description: "duplicate_content or current_version",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(restoreRoute, async (c) => {
    const { id, version } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const row = await liveFile(db, tenant_id, id);
    if (!row) return c.json(notFound, 404);
    if (version === row.version)
      return c.json(
        { code: "current_version", message: `version ${version} is already the current content` },
        409,
      );
    const source = await findFileVersion(db, tenant_id, row.id, version);
    if (!source?.sha256) return c.json(versionNotFound, 404);
    const twin = await findTwin(db, tenant_id, source.sha256, row.id);
    if (twin) return c.json(duplicate(twin), 409);
    const store = getObjectStore();
    const key = buildObjectKey(tenant_id, randomUUID());
    await store.putStream(
      key,
      await store.openRead(storageKey(source.storage_uri)),
      source.size_bytes,
    );
    const result = await applyContent(c, row.id, key, {
      filename: source.filename,
      content_type: source.content_type,
      size_bytes: source.size_bytes,
      sha256: source.sha256,
      storage_uri: composeStorageUri(key),
      scan_result: "clean",
      restored_from: version,
    });
    if (result.kind === "duplicate") return c.json(duplicate(result.twinId), 409);
    if (result.kind === "not_found") return c.json(notFound, 404);
    return c.json(toFileWire(result.row), 200);
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
    const others: Array<{ resource_type: (typeof links)[number]["resource_type"]; id: string }> =
      [];
    for (const link of links) {
      if (link.resource_type !== "conversation") {
        others.push({ resource_type: link.resource_type, id: link.resource_id });
        continue;
      }
      if (seen.has(link.resource_id)) continue;
      seen.add(link.resource_id);
      conversationsUsing.push({ id: link.resource_id, title: link.title ?? null });
    }
    const names = await linkedRecordNames(db, tenant_id, others);
    const other_links = others
      .map((link) => ({ ...link, name: names.get(`${link.resource_type}:${link.id}`) ?? null }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
    return c.json(
      { workflows: usedBy, conversations: conversationsUsing, other: others.length, other_links },
      200,
    );
  });
}

async function linkedRecordNames(
  db: Db,
  tenant_id: string,
  links: readonly { resource_type: string; id: string }[],
): Promise<Map<string, string>> {
  const ids = (type: string) =>
    links.filter((link) => link.resource_type === type).map((link) => link.id);
  const names = new Map<string, string>();
  const put = (type: string, rows: readonly { id: string; name: string | null }[]) => {
    for (const row of rows) if (row.name) names.set(`${type}:${row.id}`, row.name);
  };
  const knowledge = ids("knowledge_source");
  if (knowledge.length > 0)
    put(
      "knowledge_source",
      await db
        .select({ id: knowledgeSources.id, name: knowledgeSources.name })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            inArray(knowledgeSources.id, knowledge),
            isNull(knowledgeSources.deleted_at),
          ),
        ),
    );
  const skillIds = ids("skill");
  if (skillIds.length > 0)
    put(
      "skill",
      await db
        .select({ id: skills.id, name: skills.title })
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), inArray(skills.id, skillIds))),
    );
  const connectorIds = ids("connector");
  if (connectorIds.length > 0)
    put(
      "connector",
      await db
        .select({ id: connectors.id, name: connectors.display_name })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenant_id),
            inArray(connectors.id, connectorIds),
            isNull(connectors.deleted_at),
          ),
        ),
    );
  const runIds = ids("workflow_run");
  if (runIds.length > 0)
    put(
      "workflow_run",
      await db
        .select({ id: executions.id, name: workflows.name })
        .from(executions)
        .innerJoin(
          workflows,
          and(
            eq(workflows.tenant_id, executions.tenant_id),
            eq(workflows.id, executions.workflow_id),
          ),
        )
        .where(and(eq(executions.tenant_id, tenant_id), inArray(executions.id, runIds))),
    );
  return names;
}
