import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { fileLinks, files } from "../../db/schema/index.ts";
import { storageKey } from "../../files/resolver.ts";
import { logger } from "../../logging/logger.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import {
  type DocumentAnalysisAttachment,
  type DocumentAnalysisResult,
  runDocumentAnalysisFlow,
} from "./document-analysis.ts";

interface AnalyzeConversationAttachmentsParams {
  tenant_id: string;
  conversation_id: string;
  db: Db;
  connector_id?: string;
  slugs?: string[];
  goal?: string;
}

export async function analyzeConversationAttachments(
  p: AnalyzeConversationAttachmentsParams,
): Promise<DocumentAnalysisResult | null> {
  const rows = await p.db
    .select({ link: fileLinks, file: files })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, p.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, p.conversation_id),
        sql`${fileLinks.role} IS DISTINCT FROM ${"execution_data"}`,
      ),
    );

  const slugs = p.slugs;
  const candidates = slugs
    ? rows.filter((r) => r.link.slug !== null && slugs.includes(r.link.slug))
    : rows;
  if (candidates.length === 0) return null;

  const store = getObjectStore();
  const attachments: DocumentAnalysisAttachment[] = [];
  for (const row of candidates) {
    let content: string | undefined;
    try {
      const buf = await store.get(storageKey(row.file.storage_uri));
      content = new TextDecoder().decode(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      );
    } catch (err) {
      logger.warn({
        module: "analyze-conversation-attachments",
        action: "read_failed",
        tenant_id: p.tenant_id,
        slug: row.link.slug,
        file_id: row.file.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    attachments.push({
      storage_uri: row.file.storage_uri,
      mime_type: row.file.content_type ?? "application/octet-stream",
      filename: row.file.filename,
      content,
    });
  }
  if (attachments.length === 0) return null;

  return await runDocumentAnalysisFlow({
    tenant_id: p.tenant_id,
    attachments,
    db: p.db,
    ...(p.connector_id ? { connector_id: p.connector_id } : {}),
    ...(p.goal ? { goal: p.goal } : {}),
  });
}
