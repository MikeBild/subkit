import { createHash, randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { catalogMetadataView } from "../../api/catalog-metadata.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  BatchCreateRequestSchema,
  type BatchCreateResponse,
  BatchCreateResponseSchema,
  FileIdSchema,
  FileLinkSchema,
  type FileLinkWire,
  FileListResponseSchema,
  FileSchema,
  type FileStats,
  FileStatsSchema,
  type FileWire,
  FinalizeRequestSchema,
  InlineUploadSchema,
  LinkRequestSchema,
  ListFilesQuerySchema,
  MAX_FINALIZE_VERIFY_BYTES,
  MAX_INLINE_BYTES,
  parseFileIdOrThrow,
  toFileId,
} from "../../api/files-schemas.ts";
import {
  AuditAction,
  actorType,
  auditAwait,
  bucketSize,
  FileBatchCreatedMetadataSchema,
  FileCreatedMetadataSchema,
  FileDeletedMetadataSchema,
  FileDownloadedMetadataSchema,
  FileFinalizedMetadataSchema,
  FileScanCompletedMetadataSchema,
  FileUploadReceivedMetadataSchema,
  fileCreatorNames,
  readRequestSource,
  recordedFileCreators,
} from "../../audit/index.ts";
import { writeEvent } from "../../db/events.ts";
import { catalogGroupOrder } from "../../db/list-result.ts";
import { fileLinks, files, filesDedupSeen } from "../../db/schema/index.ts";
import { storedContentHeaders } from "../../files/content-type.ts";
import { recordFilesDedupSeen } from "../../files/dedup-counter.ts";
import { FileLinkError, linkStoredFile } from "../../files/links.ts";
import { buildObjectKey, composeStorageUri } from "../../files/object-key.ts";
import { persistInlineUpload } from "../../files/persist-inline-upload.ts";
import { removeStoredFile } from "../../files/remove-stored-file.ts";
import { requireFileForTenant, storageKey } from "../../files/resolver.ts";
import type { ScanResult } from "../../files/scanner.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS } from "../../files/scanner.ts";
import { fileReference, insertFileRow, reviveFileRow } from "../../files/slug.ts";
import { workflowUsageCounts } from "../../files/usage.ts";
import { logger } from "../../logging/index.ts";
import {
  observeFileUploadDuration,
  recordFileDedupHit,
  recordFileScanResult,
} from "../../observability/index.ts";
import { can } from "../../rbac/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TAG = "Files";

const FileIdParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
});

export function toFileWire(row: typeof files.$inferSelect): FileWire {
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

const SCAN_TIMEOUT_RESULT: ScanResult = {
  verdict: "timeout",
  engine: "timeout",
};

async function scanWithTimeout(
  stream: AsyncIterable<Uint8Array>,
  meta: { content_type: string | null; filename: string },
): Promise<ScanResult> {
  const timeoutMs = SCANNER_TIMEOUT_SECONDS * 1000;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ScanResult>((resolve) => {
    timerId = setTimeout(() => resolve(SCAN_TIMEOUT_RESULT), timeoutMs);
  });
  try {
    return await Promise.race([getScanner().scan(stream, meta), timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

async function digestObject(key: string): Promise<{ sha256: string; size: number }> {
  const store = getObjectStore();
  const it = await store.openRead(key);
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of it) {
    h.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: h.digest("hex"), size };
}

export function registerFileRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/files/:id/upload", requireAnyPermission(["file:write"]));

  const uploadRoute = createRoute({
    method: "put",
    path: "/v1/files/{id}/upload",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "Stored" },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "unauthorized",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(uploadRoute, async (c) => {
    const { id } = c.req.valid("param");
    const fid_uuid = parseFileIdOrThrow(id);
    const db = c.get("db");
    const principal = requireAuth(c);
    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fid_uuid), eq(files.tenant_id, principal.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    if (row.status !== "pending") {
      return c.json({ code: "conflict", message: `cannot upload: status=${row.status}` }, 409);
    }
    if (row.upload_url_expires_at && row.upload_url_expires_at.getTime() <= Date.now()) {
      return c.json({ code: "conflict", message: "upload slot expired" }, 409);
    }
    const key = storageKey(row.storage_uri);
    const boundSize = row.size_bytes;

    const contentLengthHeader = c.req.header("content-length");
    if (!contentLengthHeader) {
      return c.json({ code: "bad_input", message: "Content-Length is required" }, 400);
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return c.json({ code: "bad_input", message: "Content-Length is invalid" }, 400);
    }
    if (contentLength > boundSize) {
      return c.json(
        {
          code: "too_large",
          message: `body length ${contentLength} exceeds size_bytes=${boundSize}`,
        },
        413,
      );
    }
    if (contentLength !== boundSize) {
      return c.json(
        {
          code: "bad_input",
          message: `body length ${contentLength} must equal size_bytes=${boundSize}`,
        },
        400,
      );
    }

    const raw = c.req.raw.body;
    if (!raw) {
      return c.json({ code: "bad_input", message: "missing body" }, 400);
    }

    await getObjectStore().putStream(
      key,
      raw as unknown as AsyncIterable<Uint8Array>,
      contentLength,
    );
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_UPLOAD_RECEIVED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileUploadReceivedMetadataSchema.parse({
          file_id: row.id,
          size_bytes_bucket: bucketSize(boundSize),
          source: "authenticated_engine_upload",
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    return c.body(null, 200);
  });

  app.use("/v1/files", requireAnyPermission(["file:read"]));
  app.use("/v1/files/inline", requireAnyPermission(["file:write"]));
  app.use("/v1/files/batch-create", requireAnyPermission(["file:write"]));
  app.use("/v1/files/stats", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id", async (c, next) => {
    if (c.req.method === "DELETE") {
      return requireAnyPermission(["file:delete"])(c, next);
    }
    if (c.req.method === "PATCH") {
      return requireAnyPermission(["file:write"])(c, next);
    }
    return requireAnyPermission(["file:read"])(c, next);
  });
  app.use("/v1/files/:id/content", requireAnyPermission(["file:read"]));
  app.use("/v1/files/:id/finalize", requireAnyPermission(["file:write"]));
  app.use("/v1/files/:id/links", requireAnyPermission(["file:write"]));

  const inlineRoute = createRoute({
    method: "post",
    path: "/v1/files/inline",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: InlineUploadSchema } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: FileSchema } },
      },
      200: {
        description: "Dedup hit",
        content: { "application/json": { schema: FileSchema } },
      },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(inlineRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const uploadStartedAt = Date.now();

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
        {
          code: "too_large",
          message: `inline upload exceeds ${MAX_INLINE_BYTES} bytes cap`,
        },
        413,
      );
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const existing = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, sha256)))
      .limit(1);
    if (existing[0]) {
      let canonical = existing[0];
      if (canonical.deleted_at) {
        canonical = await reviveFileRow(db, canonical);
      }
      recordFileDedupHit();
      await recordFilesDedupSeen(db, tenant_id);
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_CREATED,
          resource_type: "file",
          resource_id: canonical.id,
          result: "success",
          metadata: FileCreatedMetadataSchema.parse({
            file_id: canonical.id,
            filename: body.filename,
            content_type: body.content_type ?? null,
            size_bytes_bucket: bucketSize(bytes.byteLength),
            sha256_prefix: sha256.slice(0, 16),
            dedup: true,
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
      observeFileUploadDuration({
        outcome: "success",
        duration_ms: Date.now() - uploadStartedAt,
      });
      return c.json(toFileWire(canonical), 200);
    }

    const persisted = await persistInlineUpload(db, {
      tenant_id,
      actor_id:
        principal.kind === "user" || principal.kind === "system_account" ? principal.id : null,
      filename: body.filename,
      content_type: body.content_type ?? null,
      bytes,
    });
    const { row, scan } = persisted;
    if (scan) recordFileScanResult({ verdict: scan.verdict });

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
          filename: body.filename,
          content_type: body.content_type ?? null,
          size_bytes_bucket: bucketSize(bytes.byteLength),
          sha256_prefix: sha256.slice(0, 16),
          dedup: persisted.dedup,
          request_source: readRequestSource(c),
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
            signature: scan.signature ?? null,
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
    }
    observeFileUploadDuration({
      outcome:
        !scan || scan.verdict === "clean"
          ? "success"
          : scan.verdict === "timeout"
            ? "scan_timeout"
            : "scan_infected",
      duration_ms: Date.now() - uploadStartedAt,
    });
    if (scan?.verdict === "timeout") {
      c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
    }
    return c.json(toFileWire(row), persisted.dedup ? 200 : 201);
  });

  const batchCreateRoute = createRoute({
    method: "post",
    path: "/v1/files/batch-create",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: { "application/json": { schema: BatchCreateRequestSchema } },
      },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: BatchCreateResponseSchema } },
      },
      400: {
        description: "bad_input",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(batchCreateRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const results: BatchCreateResponse["files"] = [];
    let dedup_hits = 0;

    for (const entry of body.files) {
      if (entry.sha256) {
        const existing = await db
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, entry.sha256)))
          .limit(1);
        if (existing[0]) {
          let canonical = existing[0];
          if (canonical.deleted_at) {
            canonical = await reviveFileRow(db, canonical);
          }
          dedup_hits++;
          recordFileDedupHit();
          await recordFilesDedupSeen(db, tenant_id);
          results.push({
            id: toFileId(canonical.id),
            upload_url: "",
            headers: {},
            expires_in: 0,
            dedup: true,
          });
          continue;
        }
      }

      const file_uuid = randomUUID();
      const key = buildObjectKey(tenant_id, file_uuid);
      const storage_uri = composeStorageUri(key);
      const ttlSec = 3600;
      const expires_at = new Date(Date.now() + ttlSec * 1000);

      await insertFileRow(db, {
        id: file_uuid,
        tenant_id,
        status: "pending",
        filename: entry.filename,
        content_type: entry.content_type ?? null,
        size_bytes: entry.size_bytes,
        storage_uri,
        sha256: entry.sha256 ?? null,
        upload_url_expires_at: expires_at,
        created_by:
          principal.kind === "user" || principal.kind === "system_account" ? principal.id : null,
      });

      results.push({
        id: toFileId(file_uuid),
        upload_url: `/v1/files/${toFileId(file_uuid)}/upload`,
        headers: { "content-length": String(entry.size_bytes) },
        expires_in: ttlSec,
        dedup: false,
      });
    }

    const totalSize = body.files.reduce((sum, e) => sum + (e.size_bytes ?? 0), 0);
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_BATCH_CREATED,
        resource_type: "file",
        resource_id: null,
        result: "success",
        metadata: FileBatchCreatedMetadataSchema.parse({
          count: body.files.length,
          total_size_bytes_bucket: bucketSize(totalSize),
          dedup_hits,
          request_source: readRequestSource(c),
        }),
      },
      db,
    );

    return c.json({ files: results }, 201);
  });

  const finalizeRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/finalize",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: {
        content: { "application/json": { schema: FinalizeRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Finalized",
        content: { "application/json": { schema: FileSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
      413: {
        description: "too_large",
        content: { "application/json": { schema: ErrorSchema } },
      },
      422: {
        description: "sha256_mismatch",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(finalizeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const fid_uuid = parseFileIdOrThrow(id);
    const finalizeStartedAt = Date.now();

    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, tenant_id, fid_uuid);
    } catch {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    if (row.status !== "pending" && row.status !== "uploading") {
      return c.json({ code: "conflict", message: `cannot finalize: status=${row.status}` }, 409);
    }

    if (row.size_bytes > MAX_FINALIZE_VERIFY_BYTES) {
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_FINALIZED,
          resource_type: "file",
          resource_id: row.id,
          result: "denied",
          metadata: FileFinalizedMetadataSchema.parse({
            file_id: row.id,
            status: "denied",
            outcome: "size_cap",
            content_type: row.content_type,
            size_bytes_bucket: bucketSize(row.size_bytes),
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
      logger.warn({
        module: "http.files",
        action: "finalize.size_cap",
        msg: "finalize denied — row size exceeds finalize-verify ceiling",
        file_id: row.id,
        size_bytes: row.size_bytes,
        cap: MAX_FINALIZE_VERIFY_BYTES,
      });
      return c.json(
        {
          code: "too_large",
          message: `file size ${row.size_bytes} exceeds finalize-verify ceiling of ${MAX_FINALIZE_VERIFY_BYTES} bytes`,
        },
        413,
      );
    }

    const key = storageKey(row.storage_uri);
    let digest: { sha256: string; size: number };
    try {
      digest = await digestObject(key);
    } catch (err) {
      logger.warn({
        module: "http.files",
        action: "finalize.read_failed",
        msg: "could not read object for finalize",
        file_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ code: "not_found", message: "uploaded object not found" }, 404);
    }
    const expectedClient = body.sha256;
    const expectedRow = row.sha256;
    if (digest.sha256 !== expectedClient || (expectedRow && expectedRow !== digest.sha256)) {
      await db
        .update(files)
        .set({
          status: "failed",
          sha256: digest.sha256,
          size_bytes: digest.size,
        })
        .where(eq(files.id, row.id));
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_FINALIZED,
          resource_type: "file",
          resource_id: row.id,
          result: "denied",
          metadata: FileFinalizedMetadataSchema.parse({
            file_id: row.id,
            status: "denied",
            outcome: "sha256_mismatch",
            content_type: row.content_type,
            size_bytes_bucket: bucketSize(digest.size),
            sha256_prefix: digest.sha256.slice(0, 16),
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
      observeFileUploadDuration({
        outcome: "sha_mismatch",
        duration_ms: Date.now() - finalizeStartedAt,
      });
      return c.json(
        {
          code: "sha256_mismatch",
          message: "uploaded bytes hash does not match asserted sha256",
        },
        422,
      );
    }

    const sibling = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, digest.sha256)))
      .limit(1);
    if (sibling[0] && sibling[0].id !== row.id) {
      await removeStoredFile(db, row.tenant_id, row.id, eq(files.status, row.status));
      recordFileDedupHit();
      await recordFilesDedupSeen(db, tenant_id);
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_FINALIZED,
          resource_type: "file",
          resource_id: sibling[0].id,
          result: "success",
          metadata: FileFinalizedMetadataSchema.parse({
            file_id: sibling[0].id,
            status: "ready",
            dedup: true,
            size_bytes_bucket: bucketSize(digest.size),
            sha256_prefix: digest.sha256.slice(0, 16),
            request_source: readRequestSource(c),
          }),
        },
        db,
      );
      await writeEvent(db, {
        tenant_id,
        channel: "notification.emitted",
        type: "file.finalized",
        payload: { file_id: toFileId(sibling[0].id), dedup: true },
      });
      observeFileUploadDuration({
        outcome: "success",
        duration_ms: Date.now() - finalizeStartedAt,
      });
      return c.json(toFileWire(sibling[0]), 200);
    }

    const it = await getObjectStore().openRead(key);
    const scan = await scanWithTimeout(it, {
      content_type: row.content_type ?? null,
      filename: row.filename,
    });
    recordFileScanResult({ verdict: scan.verdict });
    const status =
      scan.verdict === "clean" ? "ready" : scan.verdict === "timeout" ? "scanning" : "failed";
    const [updated] = await db
      .update(files)
      .set({
        status,
        sha256: digest.sha256,
        size_bytes: digest.size,
        scan_result: scan.verdict,
      })
      .where(eq(files.id, row.id))
      .returning();
    if (!updated) {
      return c.json({ code: "internal_error", message: "finalize update failed" }, 404);
    }

    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_FINALIZED,
        resource_type: "file",
        resource_id: updated.id,
        result: "success",
        metadata: FileFinalizedMetadataSchema.parse({
          file_id: updated.id,
          status,
          content_type: updated.content_type,
          size_bytes_bucket: bucketSize(digest.size),
          sha256_prefix: digest.sha256.slice(0, 16),
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_SCAN_COMPLETED,
        resource_type: "file",
        resource_id: updated.id,
        result:
          scan.verdict === "clean" ? "success" : scan.verdict === "timeout" ? "error" : "denied",
        metadata: FileScanCompletedMetadataSchema.parse({
          file_id: updated.id,
          verdict: scan.verdict,
          engine: scan.engine,
          signature: scan.signature ?? null,
          request_source: readRequestSource(c),
        }),
      },
      db,
    );

    if (status === "ready") {
      await writeEvent(db, {
        tenant_id,
        channel: "notification.emitted",
        type: "file.finalized",
        payload: { file_id: toFileId(updated.id) },
      });
    }

    observeFileUploadDuration({
      outcome:
        status === "ready"
          ? "success"
          : scan.verdict === "timeout"
            ? "scan_timeout"
            : "scan_infected",
      duration_ms: Date.now() - finalizeStartedAt,
    });
    if (scan.verdict === "timeout") {
      c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
    }
    return c.json(toFileWire(updated), 200);
  });

  const listRoute = createRoute({
    method: "get",
    path: "/v1/files",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { query: ListFilesQuerySchema },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: FileListResponseSchema } },
      },
    },
  });

  app.openapi(listRoute, async (c) => {
    const q = c.req.valid("query");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const limit = Math.min(q.limit ?? 20, 100);

    const tenantConds = [eq(files.tenant_id, tenant_id), isNull(files.deleted_at)];
    if (q.status) tenantConds.push(eq(files.status, q.status));
    if (q.category) tenantConds.push(eq(files.category, q.category));
    if (q.description_source) tenantConds.push(eq(files.description_source, q.description_source));
    if (q.description_source === "llm")
      tenantConds.push(sql`length(trim(coalesce(${files.description}, ''))) > 0`);
    if (q.q) {
      const needle = `%${q.q}%`;
      const search = or(
        ilike(files.filename, needle),
        ilike(files.content_type, needle),
        ilike(files.description, needle),
        ilike(files.category, needle),
      );
      if (search) tenantConds.push(search);
    }
    if (q.linked_to) {
      const colon = q.linked_to.indexOf(":");
      const rtype = q.linked_to.slice(0, colon);
      const rid = q.linked_to.slice(colon + 1);
      tenantConds.push(sql<boolean>`exists (
        select 1 from file_links fl
        where fl.tenant_id = ${tenant_id}
          and fl.file_id = ${files.id}
          and fl.resource_type = ${rtype}
          and fl.resource_id = ${rid}::uuid
      )`);
    }
    const totalConds = [...tenantConds];
    const cursorOrder =
      !q.group_by && (!q.sort || q.sort === "created_at") && (!q.order || q.order === "desc");
    if (q.cursor && cursorOrder) {
      const cursorDate = new Date(q.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        tenantConds.push(lt(files.created_at, cursorDate));
      }
    }

    const sortColumn =
      q.sort === "filename"
        ? files.filename
        : q.sort === "content_type"
          ? files.content_type
          : q.sort === "size_bytes"
            ? files.size_bytes
            : q.sort === "status"
              ? files.status
              : files.created_at;
    const ordered = q.order === "asc" ? asc(sortColumn) : desc(sortColumn);
    const [totalRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), ...totalConds.slice(1)));
    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), ...tenantConds.slice(1)))
      .orderBy(...catalogGroupOrder(q.group_by, files.category), ordered, asc(files.id))
      .limit(limit + 1)
      .offset(q.offset ?? 0);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const pageIds = page.map((r) => r.id);
    const workflowCounts = await workflowUsageCounts(db, tenant_id, page);
    const conversationRows =
      page.length > 0
        ? await db
            .select({
              id: fileLinks.file_id,
              conversations: sql<number>`count(distinct ${fileLinks.resource_id})::int`,
            })
            .from(fileLinks)
            .where(
              and(
                eq(fileLinks.tenant_id, tenant_id),
                eq(fileLinks.resource_type, "conversation"),
                inArray(fileLinks.file_id, pageIds),
              ),
            )
            .groupBy(fileLinks.file_id)
        : [];
    const conversationCounts = new Map(conversationRows.map((u) => [u.id, u.conversations]));
    const creators = await recordedFileCreators(db, tenant_id, page);
    const items = page.map((row) => ({
      ...toFileWire(row),
      creator: creators.get(row.id) ?? null,
      usage: {
        workflows: workflowCounts.get(row.id) ?? 0,
        conversations: Number(conversationCounts.get(row.id) ?? 0),
      },
    }));
    const lastVisible = hasMore && cursorOrder ? rows[limit - 1] : undefined;
    const next_cursor = lastVisible ? lastVisible.created_at.toISOString() : null;
    return c.json({ items, total: Number(totalRow?.total ?? 0), next_cursor }, 200);
  });

  const statsRoute = createRoute({
    method: "get",
    path: "/v1/files/stats",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: FileStatsSchema } },
      },
    },
  });

  app.openapi(statsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;

    const byStatusRows = await db
      .select({ status: files.status, n: count() })
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), isNull(files.deleted_at)))
      .groupBy(files.status);

    const byVerdictRows = await db
      .select({ verdict: files.scan_result, n: count() })
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), isNull(files.deleted_at)))
      .groupBy(files.scan_result);

    const sizeRows = await db
      .select({ size: files.size_bytes })
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), isNull(files.deleted_at)));

    const by_size_bucket: Record<string, number> = {};
    let total = 0;
    for (const r of sizeRows) {
      total++;
      const b = bucketSize(r.size);
      by_size_bucket[b] = (by_size_bucket[b] ?? 0) + 1;
    }

    const [dedupRow] = await db
      .select({ n: filesDedupSeen.count })
      .from(filesDedupSeen)
      .where(eq(filesDedupSeen.tenant_id, tenant_id))
      .limit(1);
    const dedup_hits = dedupRow ? Number(dedupRow.n) : 0;

    const by_status: Record<string, number> = {};
    for (const r of byStatusRows) by_status[r.status] = Number(r.n);

    const scan_verdicts: Record<string, number> = {};
    for (const r of byVerdictRows) {
      const k = r.verdict ?? "unscanned";
      scan_verdicts[k] = Number(r.n);
    }

    const out: FileStats = {
      total,
      by_status,
      by_size_bucket,
      dedup_hits,
      scan_verdicts,
    };
    return c.json(out, 200);
  });

  const getRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: FileSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    const row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id)).catch(
      () => null,
    );
    if (!row) {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    const creators = await recordedFileCreators(db, principal.tenant_id, [row]);
    const creator = creators.get(row.id) ?? null;
    const directory = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "identity:read",
      quiet: true,
    });
    const names = directory.allow
      ? await fileCreatorNames(db, principal.tenant_id, row.id, creator)
      : { name: null, api_key_name: null };
    return c.json(
      {
        ...toFileWire(row),
        creator,
        creator_name: names.name,
        creator_api_key_name: names.api_key_name,
      },
      200,
    );
  });

  const contentRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/content",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK" },
      206: { description: "Partial Content" },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      416: {
        description: "range_not_satisfiable",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(contentRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    const key = storageKey(row.storage_uri);
    const total = row.size_bytes;

    const rangeHeader = c.req.header("range");
    let range: { start: number; end: number } | null = null;
    if (rangeHeader?.startsWith("bytes=")) {
      const m = rangeHeader.slice("bytes=".length).match(/^(\d+)-(\d*)$/);
      if (m) {
        const startStr = m[1] ?? "";
        const endStr = m[2] ?? "";
        const start = Number(startStr);
        const end = endStr.length > 0 ? Number(endStr) : total - 1;
        if (start <= end && end < total) {
          range = { start, end };
        } else {
          return c.json({ code: "range_not_satisfiable", message: "range out of bounds" }, 416);
        }
      }
    }

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
          content_type: row.content_type,
          size_bytes_bucket: bucketSize(total),
          range: Boolean(range),
          request_source: readRequestSource(c),
        }),
      },
      db,
    );

    const iterable = range
      ? await getObjectStore().openReadRange(key, {
          start: range.start,
          end: range.end,
        })
      : await getObjectStore().openRead(key);
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
        if (typeof iterator.return === "function") {
          try {
            await iterator.return(reason);
          } catch {}
        }
      },
    });

    if (range) {
      const sliceLen = range.end - range.start + 1;
      return c.body(stream, 206, {
        ...storedContentHeaders(row.content_type, row.filename),
        "content-length": String(sliceLen),
        "content-range": `bytes ${range.start}-${range.end}/${total}`,
        "accept-ranges": "bytes",
      });
    }
    return c.body(stream, 200, {
      ...storedContentHeaders(row.content_type, row.filename),
      "content-length": String(total),
      "accept-ranges": "bytes",
    });
  });

  const deleteRoute = createRoute({
    method: "delete",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      204: { description: "Deleted" },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    if (row.deleted_at) {
      return c.body(null, 204);
    }
    await db.update(files).set({ deleted_at: new Date() }).where(eq(files.id, row.id));
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_DELETED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileDeletedMetadataSchema.parse({
          file_id: row.id,
          reason: "user_request",
          request_source: readRequestSource(c),
        }),
      },
      db,
    );
    await writeEvent(db, {
      tenant_id: principal.tenant_id,
      channel: "notification.emitted",
      type: "file.deleted",
      payload: { file_id: toFileId(row.id) },
    });
    return c.body(null, 204);
  });

  const linkRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/links",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: LinkRequestSchema } } },
    },
    responses: {
      201: {
        description: "Linked",
        content: { "application/json": { schema: FileLinkSchema } },
      },
      404: {
        description: "not_found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      409: {
        description: "conflict",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(linkRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    let row: typeof files.$inferSelect;
    try {
      row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id));
    } catch {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    if (row.status !== "ready") {
      return c.json(
        {
          code: "file_not_ready",
          message: `cannot link file in status=${row.status}; wait for finalize`,
          status: row.status,
        },
        409,
      );
    }
    const linkResult = await linkStoredFile(
      db,
      {
        tenant_id: principal.tenant_id,
        file_id: row.id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        slug: body.slug ?? null,
        role: body.role ?? null,
      },
      {
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: readRequestSource(c) ?? "api",
        allowed_statuses: ["ready"],
      },
    ).catch((error: unknown) => {
      if (error instanceof FileLinkError)
        return c.json({ code: error.code, message: "File link changed; reload and retry." }, 409);
      throw error;
    });

    if (linkResult instanceof Response) return linkResult;
    const linkRow = linkResult;

    const wire: FileLinkWire = {
      id: linkRow.id,
      file_id: toFileId(linkRow.file_id),
      resource_type: linkRow.resource_type,
      resource_id: linkRow.resource_id,
      slug: linkRow.slug,
      role: linkRow.role,
      created_at: linkRow.created_at.toISOString(),
    };
    return c.json(wire, 201);
  });
}
