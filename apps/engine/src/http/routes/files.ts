// Unified files HTTP surface (Wave B Step 4).
//
//   POST   /v1/files/inline              — inline base64 upload (≤5 MB)
//   POST   /v1/files/batch-create        — presigned-PUT issuance
//   PUT    /v1/files/{id}/upload         — local-disk presign sink (HMAC)
//   POST   /v1/files/{id}/finalize       — verify sha256 + scan
//   GET    /v1/files                     — list (with cursor + filters)
//   GET    /v1/files/{id}                — metadata
//   GET    /v1/files/{id}/content        — bytes (with Range support)
//   DELETE /v1/files/{id}                — soft-delete
//   POST   /v1/files/{id}/links          — attach to owning resource
//   GET    /v1/files/stats               — aggregate counters
//
// Path syntax: AIP-style verbs (`:finalize`, `:batch-create`) are NOT
// used. Hono's createRoute path is a literal template; using a colon in
// the segment name carries no benefit and risks ambiguity with the
// param syntax used elsewhere. We standardise on `/finalize` and
// `/batch-create` (no colon) per consistency item C28.
//
// The local-disk presign sink (`PUT /v1/files/{id}/upload`) bypasses
// bearer auth by design — it verifies an HMAC token from the
// presign URL and short-circuits inside the handler before
// `requireAnyPermission` would run. The token is bound to
// `(tenant_id, key, expires_at)`, so the bypass is scoped.

import { createHash, randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
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
  audit,
  auditAwait,
  bucketSize,
  FileBatchCreatedMetadataSchema,
  FileCreatedMetadataSchema,
  FileDeletedMetadataSchema,
  FileDownloadedMetadataSchema,
  FileFinalizedMetadataSchema,
  FileLinkAddedMetadataSchema,
  FileScanCompletedMetadataSchema,
} from "../../audit/index.ts";
import { getConfig } from "../../config/loader.ts";
import { writeEvent } from "../../db/events.ts";
import { fileLinks, files } from "../../db/schema/index.ts";
import { requireFileForTenant, storageKey } from "../../files/resolver.ts";
import type { ScanResult } from "../../files/scanner.ts";
import { getScanner, SCANNER_TIMEOUT_SECONDS } from "../../files/scanner.ts";
import { logger } from "../../logging/index.ts";
import {
  observeFileUploadDuration,
  recordFileDedupHit,
  recordFileScanResult,
} from "../../observability/index.ts";
import {
  getObjectStore,
  mintLocalPresignToken,
  verifyLocalPresignToken,
} from "../../storage/object-store.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const TAG = "Files";

const FileIdParam = z.object({
  id: FileIdSchema.openapi({ param: { name: "id", in: "path" } }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compose the storage URI for a backend-agnostic key. Mirrors the
 *  reverse of `storageKey(uri)` so a future test can round-trip a key
 *  through `composeStorageUri` → `storageKey` and recover the input. */
function composeStorageUri(key: string): string {
  const cfg = getConfig().storage;
  if (cfg.files.backend === "s3") {
    return `s3://${cfg.files.bucket}/${key}`;
  }
  return `local://${key}`;
}

/** Per-D8 key shape: `<tenant>/<yyyy>/<mm>/<dd>/<uuid>`. The filename
 *  lives in the DB row, never in the path. */
function buildObjectKey(tenant_id: string, file_uuid: string, now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${tenant_id}/${yyyy}/${mm}/${dd}/${file_uuid}`;
}

/** Wire-shape projection — converts DB ids to `fid_<uuid>` and dates to ISO. */
function toFileWire(row: typeof files.$inferSelect): FileWire {
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
  };
}

/** Map principal → audit actor_type. */
function actorType(p: { kind: "user" | "system_account" }): "user" | "system_account" {
  return p.kind === "user" ? "user" : "system_account";
}

/** Open an iterator over a fixed byte buffer for the synchronous scan
 *  + sha256 path. Avoids holding the whole stream API for in-memory
 *  payloads while still satisfying `ScanMeta`. */
function streamFromBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

/** Sentinel `ScanResult` used when the scan exceeds
 *  `SCANNER_TIMEOUT_SECONDS`. The caller flips the row to
 *  `status='scanning'` (NOT `ready`) so the cleanup cron can reap rows
 *  whose scan never completed. The engine identifier surfaces in audit
 *  metadata so an operator chasing a stuck row can tell the scan timed
 *  out vs. an `infected` verdict. */
const SCAN_TIMEOUT_RESULT: ScanResult = {
  verdict: "timeout",
  engine: "timeout",
};

/** Wrap `scanner.scan(...)` with a hard timeout. The default
 *  `NoopScanner` returns instantly so the race never fires; a real
 *  ClamAV-backed scanner may take seconds, so we cap the call to avoid
 *  cascading into Hono's request timeout. On timeout we resolve with
 *  `SCAN_TIMEOUT_RESULT` — the caller is responsible for leaving the row
 *  in `status='scanning'` and surfacing the state to the client. */
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

/** Stream-read the object store, computing sha256 and total length.
 *  Used by the finalize path to verify the bytes the client PUT match
 *  the asserted digest. */
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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFileRoutes(app: OpenAPIHono<AppEnv>): void {
  // ---------------------------------------------------------------------
  // Local-disk presign sink — registered BEFORE the bearer-auth gate so
  // the HMAC-only auth path inside the handler can short-circuit.
  // ---------------------------------------------------------------------

  const localUploadRoute = createRoute({
    method: "put",
    path: "/v1/files/{id}/upload",
    tags: [TAG],
    // No security entry — the HMAC token is the auth surface.
    request: {
      params: FileIdParam,
      query: z.object({
        token: z.string().min(1),
        expires_at: z.coerce.number().int().positive(),
      }),
    },
    responses: {
      200: { description: "Stored" },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
      401: {
        description: "invalid_token",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(localUploadRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { token } = c.req.valid("query");
    const fid_uuid = parseFileIdOrThrow(id);
    const db = c.get("db");
    // We need the tenant_id + storage key to verify the HMAC. The row
    // exists in `pending` state from `batch-create`; we look it up
    // without a tenant scope (the token IS the auth claim — it embeds
    // the tenant), then assert the claim matches the row.
    // tenant-filter:exempt — HMAC presign token embeds tenant_id; row verified against claims.tenant_id below.
    const rows = await db.select().from(files).where(eq(files.id, fid_uuid)).limit(1);
    const row = rows[0];
    if (!row) {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
    const key = storageKey(row.storage_uri);
    const verdict = verifyLocalPresignToken(token, { tenant_id: row.tenant_id, key });
    if (!verdict.ok) {
      return c.json(
        { code: "unauthorized", message: `presign token rejected: ${verdict.reason}` },
        401,
      );
    }
    const boundSize = verdict.claims.size_bytes;

    // Pre-flight Content-Length check. When the client sends a
    // Content-Length header we cheaply reject 413 before reading bytes.
    // Chunked / HTTP/2 / streamed clients send no Content-Length; we do
    // NOT reject those — the streaming-overflow guard below is the
    // authoritative check and aborts the producer the moment the
    // running total crosses the bound. The previous chunked-reject
    // branch broke curl `-T pipe`, fetch `body: ReadableStream`, and
    // any HTTP/2 client.
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader) {
      const cl = Number(contentLengthHeader);
      if (Number.isFinite(cl) && cl > boundSize) {
        return c.json(
          {
            code: "too_large",
            message: `body length ${cl} exceeds presign-bound size_bytes=${boundSize}`,
          },
          413,
        );
      }
    }

    // Stream the body straight through to the object store. `c.req.raw.body`
    // is a `ReadableStream<Uint8Array>` per the fetch API; we wrap it in
    // an async generator that tracks cumulative bytes against `boundSize`
    // and throws on overflow. The generator is consumed by
    // `objectStore.putStream`, which pipes to disk (local) or to the S3
    // PUT body (S3) without buffering the full payload in memory.
    const raw = c.req.raw.body;
    if (!raw) {
      return c.json({ code: "bad_input", message: "missing body" }, 400);
    }

    class StreamedOverflowError extends Error {
      constructor() {
        super(`streamed body exceeds presign-bound size_bytes=${boundSize}`);
        this.name = "StreamedOverflowError";
      }
    }

    async function* boundedBody(): AsyncIterable<Uint8Array> {
      const reader = raw!.getReader();
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (!value) continue;
          total += value.byteLength;
          if (total > boundSize) {
            // Cancel upstream so the client side of the socket gets EOF
            // promptly; the StreamedOverflowError surfaces to the caller
            // and translates to a 413 below.
            try {
              await reader.cancel();
            } catch {
              /* best-effort */
            }
            throw new StreamedOverflowError();
          }
          yield value;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* best-effort */
        }
      }
    }

    try {
      await getObjectStore().putStream(key, boundedBody());
    } catch (err) {
      if (err instanceof StreamedOverflowError) {
        // Best-effort: drop any partial object we may have started
        // writing. Idempotent — delete() no-ops if the key is absent.
        try {
          await getObjectStore().delete(key);
        } catch {
          /* best-effort */
        }
        return c.json(
          {
            code: "too_large",
            message: err.message,
          },
          413,
        );
      }
      throw err;
    }
    return c.body(null, 200);
  });

  // ---------------------------------------------------------------------
  // Permission gate — applies to every other `/v1/files*` route.
  // The local upload sink above is registered first, so this middleware
  // never short-circuits it. The pre-existing `app.use("*", auth)` in
  // the server still fires before this; the bypass only works because
  // the local-upload handler returns a `Response` before any further
  // middleware in the chain has cause to reject. Operators relying on
  // mTLS-only deployments should pin a network policy in front.
  // ---------------------------------------------------------------------

  app.use("/v1/files*", async (c, next) => {
    // Skip the gate for the local presign sink — it has its own auth.
    if (c.req.method === "PUT" && /\/v1\/files\/[^/]+\/upload$/.test(c.req.path)) {
      return next();
    }
    const method = c.req.method;
    if (method === "GET") return requireAnyPermission(["file:read"])(c, next);
    if (method === "DELETE") return requireAnyPermission(["file:delete"])(c, next);
    return requireAnyPermission(["file:write"])(c, next);
  });

  // ---------------------------------------------------------------------
  // POST /v1/files/inline
  // ---------------------------------------------------------------------

  const inlineRoute = createRoute({
    method: "post",
    path: "/v1/files/inline",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: InlineUploadSchema } } },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: FileSchema } } },
      200: { description: "Dedup hit", content: { "application/json": { schema: FileSchema } } },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(inlineRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    // Wall-clock start for FILES_UPLOAD_DURATION_SECONDS — the
    // observation lands in every terminal branch below (success / error /
    // too_large is excluded as a pre-validation reject, not an upload
    // attempt).
    const uploadStartedAt = Date.now();

    // Decode base64 → bytes. `Buffer.from(..., "base64")` is permissive
    // (whitespace OK, padding optional) which matches the inline-attach
    // legacy behaviour. Reject only if the result is empty.
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
        { code: "too_large", message: `inline upload exceeds ${MAX_INLINE_BYTES} bytes cap` },
        413,
      );
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // Dedup-probe: a prior identical-content upload short-circuits to
    // the existing row. The unique index `files_tenant_sha256_uq` is
    // the source of truth — we probe first and fall back to a SELECT on
    // unique-violation in case two requests race.
    const existing = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, sha256)))
      .limit(1);
    if (existing[0]) {
      // Don't re-write the object; existing row is the canonical home.
      recordFileDedupHit();
      await auditAwait(
        {
          tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.FILE_CREATED,
          resource_type: "file",
          resource_id: existing[0].id,
          result: "success",
          metadata: FileCreatedMetadataSchema.parse({
            file_id: existing[0].id,
            filename: body.filename,
            content_type: body.content_type ?? null,
            size_bytes_bucket: bucketSize(bytes.byteLength),
            sha256_prefix: sha256.slice(0, 16),
            dedup: true,
          }),
        },
        db,
      );
      observeFileUploadDuration({
        outcome: "success",
        duration_ms: Date.now() - uploadStartedAt,
      });
      return c.json(toFileWire(existing[0]), 200);
    }

    const file_uuid = randomUUID();
    const key = buildObjectKey(tenant_id, file_uuid);
    const storage_uri = composeStorageUri(key);

    // Write bytes first; the row commit makes the file discoverable.
    await getObjectStore().put(key, bytes);

    // Scan synchronously with a hard timeout. The default NoopScanner
    // returns instantly; a real ClamAV-backed scanner caps at
    // SCANNER_TIMEOUT_SECONDS so a slow / wedged backend cannot cascade
    // into Hono's request timeout. On timeout we leave the row in
    // `status='scanning'`, mark `scan_result='timeout'`, and rely on the
    // cleanup cron to reap stuck rows after the documented grace.
    const scan = await scanWithTimeout(streamFromBytes(bytes), {
      content_type: body.content_type ?? null,
      filename: body.filename,
    });
    recordFileScanResult({ verdict: scan.verdict });

    const status =
      scan.verdict === "clean" ? "ready" : scan.verdict === "timeout" ? "scanning" : "failed";

    let row: typeof files.$inferSelect | undefined;
    try {
      const inserted = await db
        .insert(files)
        .values({
          id: file_uuid,
          tenant_id,
          status,
          filename: body.filename,
          content_type: body.content_type ?? null,
          size_bytes: bytes.byteLength,
          storage_uri,
          sha256,
          scan_result: scan.verdict,
          created_by:
            principal.kind === "user" || principal.kind === "system_account" ? principal.id : null,
        })
        .returning();
      row = inserted[0];
    } catch (err) {
      // Concurrent dedup race: catch the unique violation, re-SELECT.
      // Drizzle wraps PG errors as DrizzleQueryError whose `.message` is
      // "Failed query: …"; the original PG constraint message lives in
      // `.cause.message`. Check both so the race path works regardless of
      // whether the error is unwrapped or not.
      const causeMsg = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("files_tenant_sha256_uq") ||
        msg.includes("duplicate key") ||
        causeMsg.includes("files_tenant_sha256_uq") ||
        causeMsg.includes("duplicate key")
      ) {
        const again = await db
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, sha256)))
          .limit(1);
        if (again[0]) {
          // Roll back the object we wrote — the existing row's
          // storage_uri is canonical.
          try {
            await getObjectStore().delete(key);
          } catch {
            /* best-effort */
          }
          recordFileDedupHit();
          observeFileUploadDuration({
            outcome: "success",
            duration_ms: Date.now() - uploadStartedAt,
          });
          return c.json(toFileWire(again[0]), 200);
        }
      }
      observeFileUploadDuration({
        outcome: "error",
        duration_ms: Date.now() - uploadStartedAt,
      });
      throw err;
    }
    if (!row) {
      observeFileUploadDuration({
        outcome: "error",
        duration_ms: Date.now() - uploadStartedAt,
      });
      return c.json({ code: "internal_error", message: "insert failed" }, 400);
    }

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
          dedup: false,
        }),
      },
      db,
    );
    // `auditAwait` sequentially so a test reading `audit_log`
    // immediately after the route returns sees both rows. Both are
    // required to be persisted before the response; the cost is one
    // extra round-trip, which the route already pays for the
    // FILE_CREATED row above.
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_SCAN_COMPLETED,
        resource_type: "file",
        resource_id: row.id,
        // `timeout` is an operational failure (scanner backend slow / wedged),
        // not a security verdict — log it as `error` so audit consumers
        // can distinguish it from an `infected` denial.
        result:
          scan.verdict === "clean" ? "success" : scan.verdict === "timeout" ? "error" : "denied",
        metadata: FileScanCompletedMetadataSchema.parse({
          file_id: row.id,
          verdict: scan.verdict,
          engine: scan.engine,
          signature: scan.signature ?? null,
        }),
      },
      db,
    );

    observeFileUploadDuration({
      outcome:
        scan.verdict === "clean"
          ? "success"
          : scan.verdict === "timeout"
            ? "scan_timeout"
            : "scan_infected",
      duration_ms: Date.now() - uploadStartedAt,
    });
    // On scan timeout the row is in `status='scanning'` and the
    // cleanup cron will reap it after the grace window. Surface the
    // state via the wire envelope + `Retry-After` so clients can poll
    // GET /v1/files/{id} instead of treating the scan as complete.
    if (scan.verdict === "timeout") {
      c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
    }
    return c.json(toFileWire(row), 201);
  });

  // ---------------------------------------------------------------------
  // POST /v1/files/batch-create
  // ---------------------------------------------------------------------

  const batchCreateRoute = createRoute({
    method: "post",
    path: "/v1/files/batch-create",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: BatchCreateRequestSchema } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: BatchCreateResponseSchema } },
      },
      400: { description: "bad_input", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(batchCreateRoute, async (c) => {
    const body = c.req.valid("json");
    const principal = requireAuth(c);
    const db = c.get("db");
    const tenant_id = principal.tenant_id;
    const store = getObjectStore();
    const cfg = getConfig().storage;
    const isLocal = cfg.files.backend !== "s3";

    const results: BatchCreateResponse["files"] = [];
    let dedup_hits = 0;

    for (const entry of body.files) {
      // Dedup-probe by client-supplied sha256.
      if (entry.sha256) {
        const existing = await db
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, entry.sha256)))
          .limit(1);
        if (existing[0]) {
          dedup_hits++;
          recordFileDedupHit();
          results.push({
            id: toFileId(existing[0].id),
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

      await db.insert(files).values({
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

      // Build the presigned URL. The local backend's presignPut returns
      // a sentinel that does NOT carry a tenant-scoped HMAC — we mint
      // our own token here so the sink route can verify (tenant, key).
      const presigned = await store.presignPut(key, ttlSec);
      let upload_url = presigned.url;
      const headers = { ...presigned.headers };
      if (isLocal) {
        // size_bytes is bound into the HMAC: the upload sink rejects
        // 413 if the streamed body exceeds the client's claimed size.
        // Without this binding a valid token could be replayed to PUT
        // arbitrary bytes; finalize would still fail on sha256, but
        // the disk-fill / S3-cost has already happened.
        const token = mintLocalPresignToken({
          tenant_id,
          key,
          expires_at: expires_at.getTime(),
          size_bytes: entry.size_bytes,
        });
        // Public sink lives at the engine root path. The client
        // composes a fully-qualified URL by prepending its engine base.
        upload_url = `/v1/files/${toFileId(file_uuid)}/upload?token=${encodeURIComponent(
          token,
        )}&expires_at=${expires_at.getTime()}`;
      }

      results.push({
        id: toFileId(file_uuid),
        upload_url,
        headers,
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
        }),
      },
      db,
    );

    return c.json({ files: results }, 201);
  });

  // ---------------------------------------------------------------------
  // POST /v1/files/{id}/finalize
  // ---------------------------------------------------------------------

  const finalizeRoute = createRoute({
    method: "post",
    path: "/v1/files/{id}/finalize",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: {
      params: FileIdParam,
      body: { content: { "application/json": { schema: FinalizeRequestSchema } } },
    },
    responses: {
      200: { description: "Finalized", content: { "application/json": { schema: FileSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "conflict", content: { "application/json": { schema: ErrorSchema } } },
      413: { description: "too_large", content: { "application/json": { schema: ErrorSchema } } },
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
    // Wall-clock for FILES_UPLOAD_DURATION_SECONDS — covers the
    // server-side finalize pass (digest + sibling-dedup + scan + row
    // update). The presigned-PUT itself is client-side and not
    // measured here.
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

    // Pre-digest size guard. The presign sink already rejects oversize
    // bodies, and the schema bounds `size_bytes` at batch-create time,
    // but a row that landed before the cap rollout (or one mutated out
    // of band) could still drive the digest pass into a multi-GB read.
    // Fail fast at 413 and audit the denial so operators see the event
    // without sifting through schema-rejection logs.
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

    // Verify the bytes the client PUT match the asserted digest.
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
        .set({ status: "failed", sha256: digest.sha256, size_bytes: digest.size })
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
          }),
        },
        db,
      );
      observeFileUploadDuration({
        outcome: "sha_mismatch",
        duration_ms: Date.now() - finalizeStartedAt,
      });
      return c.json(
        { code: "sha256_mismatch", message: "uploaded bytes hash does not match asserted sha256" },
        422,
      );
    }

    // Concurrent-dedup race resolution: a sibling upload may already
    // hold the same sha256. If so, drop our row, keep the sibling, and
    // return the sibling with `dedup: true`.
    const sibling = await db
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.sha256, digest.sha256)))
      .limit(1);
    if (sibling[0] && sibling[0].id !== row.id) {
      // Best-effort: orphan the duplicate row + object.
      try {
        await getObjectStore().delete(key);
      } catch {
        /* best-effort */
      }
      await db.delete(files).where(eq(files.id, row.id));
      recordFileDedupHit();
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
          }),
        },
        db,
      );
      // MCP notification — subscribers on `file://<sibling_fid>` get
      // an update ping. The sibling row is the canonical home for the
      // bytes after this dedup-collapse.
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

    // Scan + flip status. Hard timeout via scanWithTimeout — a stuck
    // ClamAV backend on the finalize stream cannot wedge the request.
    // On timeout the row stays in `status='scanning'` and the cleanup
    // cron reaps stuck rows after the documented grace.
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
        }),
      },
      db,
    );
    // `auditAwait` sequentially — see inline handler comment above
    // (FILE_SCAN_COMPLETED must be persisted before the route returns
    // so test ordering against `audit_log` is deterministic).
    await auditAwait(
      {
        tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_SCAN_COMPLETED,
        resource_type: "file",
        resource_id: updated.id,
        // See inline-handler comment: `timeout` is an operational failure,
        // not a security verdict.
        result:
          scan.verdict === "clean" ? "success" : scan.verdict === "timeout" ? "error" : "denied",
        metadata: FileScanCompletedMetadataSchema.parse({
          file_id: updated.id,
          verdict: scan.verdict,
          engine: scan.engine,
          signature: scan.signature ?? null,
        }),
      },
      db,
    );

    // MCP notification — only on the ready transition. A failed scan
    // moves status to `failed`; a timed-out scan parks the row in
    // `scanning`. In both non-ready cases MCP subscribers see no update
    // (R10: they couldn't read the bytes anyway). The forwarder in
    // `apps/engine/src/mcp/capabilities/resources.ts` re-checks
    // `file:read` before forwarding, so a portal-scoped principal
    // that learned the fid out-of-band cannot piggy-back.
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
    // Surface `scanning` rows with a Retry-After hint — client polls
    // GET /v1/files/{id} until status flips.
    if (scan.verdict === "timeout") {
      c.header("Retry-After", String(SCANNER_TIMEOUT_SECONDS));
    }
    return c.json(toFileWire(updated), 200);
  });

  // ---------------------------------------------------------------------
  // GET /v1/files
  // ---------------------------------------------------------------------

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

    // Cursor: opaque ISO `created_at` timestamp; rows older than the
    // cursor are returned. Last-page cursors are nullable in the
    // response envelope.
    // List handler — `tenantConds` is the documented name the audit AST
    // scan picks up as a tenant signal (see `.tenant-filter-allowlist.txt`
    // convention note). Do not rename.
    const tenantConds = [eq(files.tenant_id, tenant_id), isNull(files.deleted_at)];
    if (q.status) tenantConds.push(eq(files.status, q.status));
    if (q.cursor) {
      const cursorDate = new Date(q.cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        tenantConds.push(lt(files.created_at, cursorDate));
      }
    }

    let rows = await db
      .select()
      .from(files)
      .where(and(...tenantConds))
      .orderBy(desc(files.created_at))
      .limit(limit + 1);

    // `linked_to=<type>:<id>` post-filter — join intersection against
    // `file_links`. Cheap for the small windows the list endpoint
    // returns; reconsider when tenants routinely page past 1k files.
    if (q.linked_to) {
      const colon = q.linked_to.indexOf(":");
      const rtype = q.linked_to.slice(0, colon);
      const rid = q.linked_to.slice(colon + 1);
      const linkRows = await db
        .select({ file_id: fileLinks.file_id })
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, tenant_id),
            // resource_type enum is narrow; the regex on the query
            // schema validated the shape.
            eq(fileLinks.resource_type, rtype as "conversation"),
            eq(fileLinks.resource_id, rid),
          ),
        );
      const allow = new Set(linkRows.map((r) => r.file_id));
      rows = rows.filter((r) => allow.has(r.id));
    }

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toFileWire);
    const lastVisible = hasMore ? rows[limit - 1] : undefined;
    const next_cursor = lastVisible ? lastVisible.created_at.toISOString() : null;
    return c.json({ items, next_cursor }, 200);
  });

  // ---------------------------------------------------------------------
  // GET /v1/files/stats
  // ---------------------------------------------------------------------

  const statsRoute = createRoute({
    method: "get",
    path: "/v1/files/stats",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "OK", content: { "application/json": { schema: FileStatsSchema } } },
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

    // Size buckets come out of the row scan — drizzle does not have a
    // first-class CASE helper here, and the rowcount per tenant is
    // bounded by the cleanup cron, so a single SELECT is fine.
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

    // Dedup hits = number of files that have >1 link rows. The
    // unlinked / single-link case is the dominant one so we sum over
    // grouped counts.
    const linkCountRows = await db
      .select({ file_id: fileLinks.file_id, n: count() })
      .from(fileLinks)
      .where(eq(fileLinks.tenant_id, tenant_id))
      .groupBy(fileLinks.file_id);
    let dedup_hits = 0;
    for (const r of linkCountRows) {
      const n = Number(r.n);
      if (n > 1) dedup_hits += n - 1;
    }

    const by_status: Record<string, number> = {};
    for (const r of byStatusRows) by_status[r.status] = Number(r.n);

    const scan_verdicts: Record<string, number> = {};
    for (const r of byVerdictRows) {
      const k = r.verdict ?? "unscanned";
      scan_verdicts[k] = Number(r.n);
    }

    const out: FileStats = { total, by_status, by_size_bucket, dedup_hits, scan_verdicts };
    return c.json(out, 200);
  });

  // ---------------------------------------------------------------------
  // GET /v1/files/{id}
  // ---------------------------------------------------------------------

  const getRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK", content: { "application/json": { schema: FileSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const principal = requireAuth(c);
    const db = c.get("db");
    try {
      const row = await requireFileForTenant(db, principal.tenant_id, parseFileIdOrThrow(id));
      return c.json(toFileWire(row), 200);
    } catch {
      return c.json({ code: "not_found", message: "file not found" }, 404);
    }
  });

  // ---------------------------------------------------------------------
  // GET /v1/files/{id}/content
  // ---------------------------------------------------------------------

  const contentRoute = createRoute({
    method: "get",
    path: "/v1/files/{id}/content",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      200: { description: "OK" },
      206: { description: "Partial Content" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
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
    const ct = row.content_type ?? "application/octet-stream";
    const total = row.size_bytes;

    // Range parsing — single-range only (`bytes=START-END`). Multi-range
    // and suffix-only ranges fall through to the full-content path; the
    // CDN can synthesize them upstream if it wants.
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

    // We load the full object then slice — sufficient for the 5 MB
    // inline cap. The streaming-Range upgrade lands with Wave C's
    // large-file path. `Buffer` → `Uint8Array` view so the fetch-api
    // `Response` constructor (which types `BodyInit` against the DOM
    // lib) accepts it without an `as unknown` cast.
    const buf = await getObjectStore().get(key);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    audit({
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
      }),
    });

    if (range) {
      const slice = bytes.subarray(range.start, range.end + 1);
      return c.body(slice as unknown as ArrayBuffer, 206, {
        "content-type": ct,
        "content-length": String(slice.byteLength),
        "content-range": `bytes ${range.start}-${range.end}/${total}`,
        "accept-ranges": "bytes",
      });
    }
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "content-type": ct,
      "content-length": String(bytes.byteLength),
      "accept-ranges": "bytes",
    });
  });

  // ---------------------------------------------------------------------
  // DELETE /v1/files/{id}
  // ---------------------------------------------------------------------

  const deleteRoute = createRoute({
    method: "delete",
    path: "/v1/files/{id}",
    tags: [TAG],
    security: [{ bearerAuth: [] }],
    request: { params: FileIdParam },
    responses: {
      204: { description: "Deleted" },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
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
      // Already soft-deleted — idempotent 204.
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
        }),
      },
      db,
    );
    // MCP notification — subscribers on `file://<fid>` get a ping
    // so they can react to the file disappearing. The forwarder
    // re-checks `file:read`; a row that has just been soft-deleted
    // still resolves (the resolver ignores `deleted_at` per R10's
    // grace window) so the RBAC re-check passes during the
    // notification window.
    await writeEvent(db, {
      tenant_id: principal.tenant_id,
      channel: "notification.emitted",
      type: "file.deleted",
      payload: { file_id: toFileId(row.id) },
    });
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------------
  // POST /v1/files/{id}/links
  // ---------------------------------------------------------------------

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
      201: { description: "Linked", content: { "application/json": { schema: FileLinkSchema } } },
      404: { description: "not_found", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "conflict", content: { "application/json": { schema: ErrorSchema } } },
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
    // ON CONFLICT DO NOTHING via the (tenant_id, resource_type,
    // resource_id, slug) unique index. The returning() result is empty
    // on a no-op conflict; we re-SELECT to give the caller a stable
    // shape regardless of race outcome.
    const inserted = await db
      .insert(fileLinks)
      .values({
        tenant_id: principal.tenant_id,
        file_id: row.id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        slug: body.slug ?? null,
        role: body.role ?? null,
      })
      .onConflictDoNothing()
      .returning();
    let linkRow = inserted[0];
    if (!linkRow) {
      // Conflict — find the existing matching row to return.
      const existing = await db
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, principal.tenant_id),
            eq(fileLinks.file_id, row.id),
            eq(fileLinks.resource_type, body.resource_type),
            eq(fileLinks.resource_id, body.resource_id),
          ),
        )
        .limit(1);
      linkRow = existing[0];
    }
    if (!linkRow) {
      return c.json({ code: "conflict", message: "link conflict" }, 409);
    }

    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        action: AuditAction.FILE_LINK_ADDED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileLinkAddedMetadataSchema.parse({
          file_id: row.id,
          resource_type: body.resource_type,
          resource_id: body.resource_id,
          slug: body.slug ?? null,
          role: body.role ?? null,
        }),
      },
      db,
    );

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
