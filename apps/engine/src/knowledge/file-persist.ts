import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { bucketSize } from "../audit/buckets.ts";
import {
  AuditAction,
  FileCreatedMetadataSchema,
  FileLinkAddedMetadataSchema,
  FileScanCompletedMetadataSchema,
} from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { fileLinks } from "../db/schema/files.ts";
import { recordFilesDedupSeen } from "../files/dedup-counter.ts";
import {
  type PersistInlineUploadResult,
  persistInlineUpload,
} from "../files/persist-inline-upload.ts";
import { removeStoredFile } from "../files/remove-stored-file.ts";

export async function persistKnowledgeFile(
  db: Executor,
  p: {
    tenant_id: string;
    actor: Actor | null;
    upload: { buffer: Buffer | Uint8Array | string; filename: string; mime?: string };
  },
): Promise<PersistInlineUploadResult> {
  const bytes: Uint8Array =
    typeof p.upload.buffer === "string" ? Buffer.from(p.upload.buffer, "utf8") : p.upload.buffer;
  const persisted = await persistInlineUpload(db as Db, {
    tenant_id: p.tenant_id,
    actor_id: p.actor?.id ?? null,
    filename: p.upload.filename,
    content_type: p.upload.mime ?? null,
    bytes,
  });
  if (persisted.dedup) await recordFilesDedupSeen(db as Db, p.tenant_id);
  return persisted;
}

export async function cleanupPersistedKnowledgeFile(
  db: Executor,
  persisted: PersistInlineUploadResult | null,
): Promise<void> {
  if (!persisted || persisted.dedup) return;
  await removeStoredFile(db, persisted.row.tenant_id, persisted.row.id);
}

export async function linkKnowledgeFile(
  tx: Executor,
  p: {
    tenant_id: string;
    actor: Actor | null;
    knowledge_source_id: string;
    slug: string;
    filename: string;
    mime: string | null;
    persisted: PersistInlineUploadResult;
  },
): Promise<void> {
  const { row, dedup, scan } = p.persisted;
  const actorFields = auditActor(p.actor);
  await tx
    .insert(fileLinks)
    .values({
      tenant_id: p.tenant_id,
      file_id: row.id,
      resource_type: "knowledge_source",
      resource_id: p.knowledge_source_id,
      slug: p.slug,
      role: "source",
    })
    .onConflictDoNothing();
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...actorFields,
      action: AuditAction.FILE_CREATED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileCreatedMetadataSchema.parse({
        file_id: row.id,
        filename: p.filename.slice(0, 255),
        content_type: p.mime,
        size_bytes_bucket: bucketSize(row.size_bytes),
        sha256_prefix: row.sha256 ? row.sha256.slice(0, 16) : undefined,
        dedup,
        source: "knowledge_source",
      }),
    },
    tx,
  );
  if (scan) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actorFields,
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
        }),
      },
      tx,
    );
  }
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...actorFields,
      action: AuditAction.FILE_LINK_ADDED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileLinkAddedMetadataSchema.parse({
        file_id: row.id,
        resource_type: "knowledge_source",
        resource_id: p.knowledge_source_id,
        slug: p.slug,
        role: "source",
        source: "knowledge_source",
      }),
    },
    tx,
  );
}
