// Bridges conversation attachments to runDocumentAnalysisFlow.
//
// Conversation tools (save_connector_draft, build_workflow) call this
// when an authoring step crosses a boundary that benefits from
// extracted endpoint metadata. The helper reads attachment payloads
// via the same content reader the @attachment:slug resolver uses,
// then delegates to runDocumentAnalysisFlow which writes to the
// endpoint registry and emits the DOCUMENT_ANALYZED audit row.

import { eq } from "drizzle-orm";
import { type ContentReader, defaultContentReader } from "../../conversations/attachments.ts";
import type { Db } from "../../db/client.ts";
import { conversationAttachments } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import {
  type DocumentAnalysisAttachment,
  type DocumentAnalysisResult,
  runDocumentAnalysisFlow,
} from "./document-analysis.ts";

export interface AnalyzeConversationAttachmentsParams {
  tenant_id: string;
  conversation_id: string;
  db: Db;
  /** Persist endpoint registry rows under this connector when set. */
  connector_id?: string;
  /** Optional list of slugs to limit analysis to. */
  slugs?: string[];
  /** Free-form goal forwarded to runDocumentAnalysisFlow. */
  goal?: string;
  /** Test override. */
  read?: ContentReader;
}

export async function analyzeConversationAttachments(
  p: AnalyzeConversationAttachmentsParams,
): Promise<DocumentAnalysisResult | null> {
  const rows = await p.db
    .select()
    .from(conversationAttachments)
    .where(eq(conversationAttachments.conversation_id, p.conversation_id));

  const slugs = p.slugs;
  const candidates = slugs ? rows.filter((r) => slugs.includes(r.slug)) : rows;
  if (candidates.length === 0) return null;

  const reader = p.read ?? defaultContentReader;
  const attachments: DocumentAnalysisAttachment[] = [];
  for (const row of candidates) {
    let content: string | undefined;
    try {
      content = await reader(row.storage_uri);
    } catch (err) {
      logger.warn({
        module: "analyze-conversation-attachments",
        action: "read_failed",
        tenant_id: p.tenant_id,
        slug: row.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    attachments.push({
      storage_uri: row.storage_uri,
      mime_type: row.content_type ?? "application/octet-stream",
      filename: row.original_filename,
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
