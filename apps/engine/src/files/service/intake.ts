import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type BatchCreateRequest,
  MAX_FINALIZE_VERIFY_BYTES,
  toFileId,
} from "../../api/files-schemas.ts";
import {
  AuditAction,
  auditAwait,
  auditAwaitStandalone,
  bucketSize,
  FileBatchCreatedMetadataSchema,
  FileCreatedMetadataSchema,
  FileFinalizedMetadataSchema,
  FileScanCompletedMetadataSchema,
  FileUploadReceivedMetadataSchema,
} from "../../audit/index.ts";
import type { Db } from "../../db/client.ts";
import { writeEvent } from "../../db/events.ts";
import { files } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import {
  observeFileUploadDuration,
  recordFileDedupHit,
  recordFileScanResult,
} from "../../observability/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { recordFilesDedupSeen } from "../dedup-counter.ts";
import { buildObjectKey, composeStorageUri } from "../object-key.ts";
import { persistInlineUpload } from "../persist-inline-upload.ts";
import { removeStoredFile } from "../remove-stored-file.ts";
import { storageKey } from "../resolver.ts";
import { insertFileRow, reviveFileRow } from "../slug.ts";
import {
  auditedBy,
  creatorId,
  type FileActor,
  type FileRow,
  findTenantFile,
  scanVerdictResult,
  scanWithTimeout,
} from "./shared.ts";

const UPLOAD_SLOT_TTL_SECONDS = 3600;

export type UploadSlot =
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "open"; row: FileRow };

export async function findUploadSlot(
  db: Db,
  tenantId: string,
  fileUuid: string,
): Promise<UploadSlot> {
  const row = await findTenantFile(db, tenantId, fileUuid);
  if (!row) return { kind: "not_found" };
  if (row.status !== "pending") {
    return { kind: "conflict", message: `cannot upload: status=${row.status}` };
  }
  if (row.upload_url_expires_at && row.upload_url_expires_at.getTime() <= Date.now()) {
    return { kind: "conflict", message: "upload slot expired" };
  }
  return { kind: "open", row };
}

export async function storeUpload(
  db: Db,
  actor: FileActor,
  row: FileRow,
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  await getObjectStore().putStream(storageKey(row.storage_uri), body, row.size_bytes);
  await auditAwait(
    {
      ...auditedBy(actor),
      tenant_id: row.tenant_id,
      action: AuditAction.FILE_UPLOAD_RECEIVED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileUploadReceivedMetadataSchema.parse({
        file_id: row.id,
        size_bytes_bucket: bucketSize(row.size_bytes),
        source: "authenticated_engine_upload",
        request_source: actor.request_source,
      }),
    },
    db,
  );
}

export interface InlineFileInput {
  filename: string;
  content_type: string | null;
  bytes: Uint8Array;
  started_at: number;
}

export interface InlineFileOutcome {
  row: FileRow;
  created: boolean;
  scan_timed_out: boolean;
}

async function sameContentFile(db: Db, tenantId: string, sha256: string) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenantId), eq(files.sha256, sha256)))
    .limit(1);
  return row;
}

async function reuseCanonical(db: Db, tenantId: string, existing: FileRow): Promise<FileRow> {
  const canonical = existing.deleted_at ? await reviveFileRow(db, existing) : existing;
  recordFileDedupHit();
  await recordFilesDedupSeen(db, tenantId);
  return canonical;
}

export async function createInlineFile(
  db: Db,
  actor: FileActor,
  input: InlineFileInput,
): Promise<InlineFileOutcome> {
  const tenant_id = actor.principal.tenant_id;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const createdMetadata = (fileId: string, dedup: boolean) =>
    FileCreatedMetadataSchema.parse({
      file_id: fileId,
      filename: input.filename,
      content_type: input.content_type,
      size_bytes_bucket: bucketSize(input.bytes.byteLength),
      sha256_prefix: sha256.slice(0, 16),
      dedup,
      request_source: actor.request_source,
    });

  const existing = await sameContentFile(db, tenant_id, sha256);
  if (existing) {
    const canonical = await reuseCanonical(db, tenant_id, existing);
    await auditAwaitStandalone(
      {
        ...auditedBy(actor),
        action: AuditAction.FILE_CREATED,
        resource_type: "file",
        resource_id: canonical.id,
        result: "success",
        metadata: createdMetadata(canonical.id, true),
      },
      db,
    );
    observeFileUploadDuration({
      outcome: "success",
      duration_ms: Date.now() - input.started_at,
    });
    return { row: canonical, created: false, scan_timed_out: false };
  }

  const persisted = await persistInlineUpload(db, {
    tenant_id,
    actor_id: creatorId(actor.principal),
    filename: input.filename,
    content_type: input.content_type,
    bytes: input.bytes,
  });
  const { row, scan } = persisted;
  if (scan) recordFileScanResult({ verdict: scan.verdict });

  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_CREATED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: createdMetadata(row.id, persisted.dedup),
    },
    db,
  );
  if (scan) {
    await auditAwait(
      {
        ...auditedBy(actor),
        action: AuditAction.FILE_SCAN_COMPLETED,
        resource_type: "file",
        resource_id: row.id,
        result: scanVerdictResult(scan.verdict),
        metadata: FileScanCompletedMetadataSchema.parse({
          file_id: row.id,
          verdict: scan.verdict,
          engine: scan.engine,
          signature: scan.signature ?? null,
          request_source: actor.request_source,
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
    duration_ms: Date.now() - input.started_at,
  });
  return { row, created: !persisted.dedup, scan_timed_out: scan?.verdict === "timeout" };
}

export interface UploadSlotGrant {
  file_id: string;
  dedup: boolean;
  size_bytes: number;
  expires_in: number;
}

export async function createUploadSlots(
  db: Db,
  actor: FileActor,
  entries: BatchCreateRequest["files"],
): Promise<UploadSlotGrant[]> {
  const tenant_id = actor.principal.tenant_id;
  const grants: UploadSlotGrant[] = [];
  let dedup_hits = 0;

  for (const entry of entries) {
    if (entry.sha256) {
      const existing = await sameContentFile(db, tenant_id, entry.sha256);
      if (existing) {
        const canonical = await reuseCanonical(db, tenant_id, existing);
        dedup_hits++;
        grants.push({
          file_id: canonical.id,
          dedup: true,
          size_bytes: entry.size_bytes,
          expires_in: 0,
        });
        continue;
      }
    }

    const file_uuid = randomUUID();
    const storage_uri = composeStorageUri(buildObjectKey(tenant_id, file_uuid));
    await insertFileRow(db, {
      id: file_uuid,
      tenant_id,
      status: "pending",
      filename: entry.filename,
      content_type: entry.content_type ?? null,
      size_bytes: entry.size_bytes,
      storage_uri,
      sha256: entry.sha256 ?? null,
      upload_url_expires_at: new Date(Date.now() + UPLOAD_SLOT_TTL_SECONDS * 1000),
      created_by: creatorId(actor.principal),
    });
    grants.push({
      file_id: file_uuid,
      dedup: false,
      size_bytes: entry.size_bytes,
      expires_in: UPLOAD_SLOT_TTL_SECONDS,
    });
  }

  const totalSize = entries.reduce((sum, e) => sum + (e.size_bytes ?? 0), 0);
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_BATCH_CREATED,
      resource_type: "file",
      resource_id: null,
      result: "success",
      metadata: FileBatchCreatedMetadataSchema.parse({
        count: entries.length,
        total_size_bytes_bucket: bucketSize(totalSize),
        dedup_hits,
        request_source: actor.request_source,
      }),
    },
    db,
  );
  return grants;
}

export type FinalizeOutcome =
  | { kind: "not_found" }
  | { kind: "conflict"; status: string }
  | { kind: "too_large"; size_bytes: number }
  | { kind: "object_missing" }
  | { kind: "sha256_mismatch" }
  | { kind: "update_failed" }
  | { kind: "finalized"; row: FileRow; scan_timed_out: boolean };

async function digestObject(key: string): Promise<{ sha256: string; size: number }> {
  const it = await getObjectStore().openRead(key);
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of it) {
    h.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: h.digest("hex"), size };
}

export async function finalizeFile(
  db: Db,
  actor: FileActor,
  input: { file_uuid: string; sha256: string; started_at: number },
): Promise<FinalizeOutcome> {
  const tenant_id = actor.principal.tenant_id;
  const row = await findTenantFile(db, tenant_id, input.file_uuid);
  if (!row) return { kind: "not_found" };
  if (row.status !== "pending" && row.status !== "uploading") {
    return { kind: "conflict", status: row.status };
  }

  if (row.size_bytes > MAX_FINALIZE_VERIFY_BYTES) {
    await auditAwait(
      {
        ...auditedBy(actor),
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
          request_source: actor.request_source,
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
    return { kind: "too_large", size_bytes: row.size_bytes };
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
    return { kind: "object_missing" };
  }
  if (digest.sha256 !== input.sha256 || (row.sha256 && row.sha256 !== digest.sha256)) {
    await db
      .update(files)
      .set({ status: "failed", sha256: digest.sha256, size_bytes: digest.size })
      .where(and(eq(files.tenant_id, tenant_id), eq(files.id, row.id)));
    await auditAwait(
      {
        ...auditedBy(actor),
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
          request_source: actor.request_source,
        }),
      },
      db,
    );
    observeFileUploadDuration({
      outcome: "sha_mismatch",
      duration_ms: Date.now() - input.started_at,
    });
    return { kind: "sha256_mismatch" };
  }

  const sibling = await sameContentFile(db, tenant_id, digest.sha256);
  if (sibling && sibling.id !== row.id) {
    await removeStoredFile(db, row.tenant_id, row.id, eq(files.status, row.status));
    recordFileDedupHit();
    await recordFilesDedupSeen(db, tenant_id);
    await auditAwait(
      {
        ...auditedBy(actor),
        action: AuditAction.FILE_FINALIZED,
        resource_type: "file",
        resource_id: sibling.id,
        result: "success",
        metadata: FileFinalizedMetadataSchema.parse({
          file_id: sibling.id,
          status: "ready",
          dedup: true,
          size_bytes_bucket: bucketSize(digest.size),
          sha256_prefix: digest.sha256.slice(0, 16),
          request_source: actor.request_source,
        }),
      },
      db,
    );
    await writeEvent(db, {
      tenant_id,
      channel: "notification.emitted",
      type: "file.finalized",
      payload: { file_id: toFileId(sibling.id), dedup: true },
    });
    observeFileUploadDuration({
      outcome: "success",
      duration_ms: Date.now() - input.started_at,
    });
    return { kind: "finalized", row: sibling, scan_timed_out: false };
  }

  const scan = await scanWithTimeout(await getObjectStore().openRead(key), {
    content_type: row.content_type ?? null,
    filename: row.filename,
  });
  recordFileScanResult({ verdict: scan.verdict });
  const status =
    scan.verdict === "clean" ? "ready" : scan.verdict === "timeout" ? "scanning" : "failed";
  const [updated] = await db
    .update(files)
    .set({ status, sha256: digest.sha256, size_bytes: digest.size, scan_result: scan.verdict })
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, row.id)))
    .returning();
  if (!updated) return { kind: "update_failed" };

  await auditAwait(
    {
      ...auditedBy(actor),
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
        request_source: actor.request_source,
      }),
    },
    db,
  );
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_SCAN_COMPLETED,
      resource_type: "file",
      resource_id: updated.id,
      result: scanVerdictResult(scan.verdict),
      metadata: FileScanCompletedMetadataSchema.parse({
        file_id: updated.id,
        verdict: scan.verdict,
        engine: scan.engine,
        signature: scan.signature ?? null,
        request_source: actor.request_source,
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
    duration_ms: Date.now() - input.started_at,
  });
  return { kind: "finalized", row: updated, scan_timed_out: scan.verdict === "timeout" };
}
