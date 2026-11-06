import { and, desc, eq } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileCreatedMetadataSchema,
  FileLinkRemovedMetadataSchema,
  FileScanCompletedMetadataSchema,
} from "../../audit/index.ts";
import type { Db, Executor } from "../../db/client.ts";
import { conversations, fileLinks, files } from "../../db/schema/index.ts";
import type { PersistedScan } from "../persist-inline-upload.ts";
import { auditedBy, type FileActor, type FileRow, scanVerdictResult } from "./shared.ts";

export interface ConversationAttachmentRow {
  file: FileRow;
  link_slug: string | null;
  link_created_at: Date;
}

export interface StoredConversationAttachment {
  row: FileRow;
  filename: string;
  size_bytes: number;
  dedup: boolean;
  scan: PersistedScan | null;
}

export async function conversationExists(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenantId), eq(conversations.id, conversationId)))
    .limit(1);
  return Boolean(row);
}

export async function listConversationAttachments(
  db: Executor,
  tenantId: string,
  conversationId: string,
  limit?: number,
): Promise<ConversationAttachmentRow[]> {
  const query = db
    .select({ link_slug: fileLinks.slug, link_created_at: fileLinks.created_at, file: files })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, tenantId),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, conversationId),
      ),
    )
    .orderBy(desc(fileLinks.created_at))
    .$dynamic();
  return limit === undefined ? query : query.limit(limit);
}

export async function auditConversationAttachmentStored(
  db: Db,
  actor: FileActor,
  stored: StoredConversationAttachment,
): Promise<void> {
  const { row, scan } = stored;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_CREATED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileCreatedMetadataSchema.parse({
        file_id: row.id,
        filename: stored.filename,
        content_type: row.content_type,
        size_bytes_bucket: bucketSize(stored.size_bytes),
        sha256_prefix: row.sha256 ? row.sha256.slice(0, 16) : undefined,
        dedup: stored.dedup,
        request_source: actor.request_source,
        source: "conversation_attachments",
      }),
    },
    db,
  );
  if (!scan) return;
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
        signature: scan.signature,
        request_source: actor.request_source,
      }),
    },
    db,
  );
}

export async function unlinkConversationAttachment(
  db: Db,
  actor: FileActor,
  conversationId: string,
  slug: string,
): Promise<boolean> {
  const tenantId = actor.principal.tenant_id;
  const [link] = await db
    .select()
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, tenantId),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, conversationId),
        eq(fileLinks.slug, slug),
      ),
    )
    .limit(1);
  if (!link) return false;
  await db
    .delete(fileLinks)
    .where(and(eq(fileLinks.tenant_id, tenantId), eq(fileLinks.id, link.id)));
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_LINK_REMOVED,
      resource_type: "file",
      resource_id: link.file_id,
      result: "success",
      metadata: FileLinkRemovedMetadataSchema.parse({
        file_id: link.file_id,
        resource_type: "conversation",
        resource_id: conversationId,
        slug,
        request_source: actor.request_source,
      }),
    },
    db,
  );
  return true;
}
