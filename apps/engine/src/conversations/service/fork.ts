import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import type { AuditActorType } from "../../audit/types.ts";
import { AuditAction, ConversationForkedMetadataSchema } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations, fileLinks } from "../../db/schema/index.ts";
import { linkStoredFile } from "../../files/links.ts";
import { log } from "../../logging/logger.ts";
import { forkPlaybookDocument } from "../playbook.ts";
import type { ConversationRecord } from "../types.ts";
import { rowToRecord } from "./shared.ts";

export interface ForkConversationParams {
  tenant_id: string;
  source_conversation_id: string;
  anchor_message_id: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  title?: string | null;
  request_source: "api" | "cli" | "scheduler" | "mcp" | "webhook" | "tool-chain" | "ui" | "chat";
}

export interface ForkConversationResult {
  conversation: ConversationRecord;
  source_conversation_id: string;
  anchor_message_id: string;
  copied_message_count: number;
  truncated: boolean;
}

export const FORK_COPY_MESSAGE_CAP = 5_000;

export async function forkConversation(
  p: ForkConversationParams,
  exec: Db,
): Promise<ForkConversationResult | null> {
  const [source] = await exec
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.source_conversation_id)),
    );
  if (!source) return null;
  const allMessages = await exec
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        eq(conversationMessages.conversation_id, p.source_conversation_id),
      ),
    )
    .orderBy(asc(conversationMessages.created_at), asc(conversationMessages.id));
  const anchorIdx = allMessages.findIndex((m) => m.id === p.anchor_message_id);
  if (anchorIdx < 0) return null;

  const playbook = source.playbook_mode === "off" ? null : forkPlaybookDocument(source.playbook);
  const forkTitle = p.title ?? `fork — ${source.title ?? source.id.slice(0, 8)}`;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: source.target_connector_id,
      target_workflow_id: source.target_workflow_id,
      status: "active",
      origin_client: source.origin_client ?? null,
      surface: source.surface ?? null,
      draft: source.draft,
      playbook_mode: source.playbook_mode,
      playbook,
      playbook_revision: playbook ? 1 : 0,
      owner_id: p.actor_id ?? source.owner_id ?? null,
      loaded_skills: source.loaded_skills,
      turn_count: source.turn_count,
      title: forkTitle,
      memory: source.memory,
      ...(source.model ? { model: source.model } : {}),
    })
    .returning();
  assertInsertRow(row, "conversations");

  const fullSlice = allMessages.slice(0, anchorIdx + 1);
  const truncated = fullSlice.length > FORK_COPY_MESSAGE_CAP;
  const messagesToCopy = truncated
    ? fullSlice.slice(fullSlice.length - FORK_COPY_MESSAGE_CAP)
    : fullSlice;
  let copiedCount = 0;
  if (messagesToCopy.length > 0) {
    await exec.insert(conversationMessages).values(
      messagesToCopy.map((m) => ({
        tenant_id: p.tenant_id,
        conversation_id: row.id,
        role: m.role,
        content: m.content,
        model: m.model,
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out,
      })),
    );
    copiedCount = messagesToCopy.length;
  }

  const sourceLinks = await exec
    .select({
      file_id: fileLinks.file_id,
      slug: fileLinks.slug,
      role: fileLinks.role,
    })
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, p.tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, p.source_conversation_id),
      ),
    );
  for (const link of sourceLinks) {
    await linkStoredFile(
      exec,
      {
        tenant_id: p.tenant_id,
        file_id: link.file_id,
        resource_type: "conversation",
        resource_id: row.id,
        slug: link.slug,
        role: link.role,
      },
      {
        actor_type: p.actor_type,
        actor_id: p.actor_id,
        request_source: p.request_source,
        source: "fork",
        allowed_statuses: ["pending", "uploading", "scanning", "ready", "failed", "expired"],
      },
    );
  }

  log.conversation.forked({
    conversation_id: row.id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    connector_id: source.target_connector_id ?? null,
    workflow_id: source.target_workflow_id ?? null,
    forked_from: p.source_conversation_id,
    anchor_message_id: p.anchor_message_id,
    copied_message_count: copiedCount,
    memory_included: Boolean(source.memory),
    truncated,
    source_message_count: fullSlice.length,
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_type,
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_FORKED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      reason: `forked from ${p.source_conversation_id} at message ${p.anchor_message_id}`,
      metadata: ConversationForkedMetadataSchema.parse({
        forked_from: p.source_conversation_id,
        anchor_message_id: p.anchor_message_id,
        copied_message_count: copiedCount,
        tool_calls_omitted: true,
        elicitations_omitted: true,
        truncated,
        source_message_count: fullSlice.length,
        copy_cap: FORK_COPY_MESSAGE_CAP,
        request_source: p.request_source,
      }),
    },
    exec,
  );

  return {
    conversation: rowToRecord(row),
    source_conversation_id: p.source_conversation_id,
    anchor_message_id: p.anchor_message_id,
    copied_message_count: copiedCount,
    truncated,
  };
}
