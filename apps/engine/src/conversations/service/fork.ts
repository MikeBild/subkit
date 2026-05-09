// Fork a conversation at a specific message id. Creates a new
// conversation row owned by the same actor + tenant, copies every
// message up to and including the anchor message into the new
// conversation, and returns the new conversation id.
//
// G10 closure of #159 M10. Tool calls and elicitations are NOT
// copied — they're tied to the message ids in the source conversation
// and re-running them in the fork would duplicate their side effects.
// The forked conversation starts as a clean session that has the
// message history but none of the tool-result side-effect markers.

import { and, asc, eq, lte } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import type { ConversationRecord } from "../types.ts";
import { rowToRecord } from "./shared.ts";

export interface ForkConversationParams {
  tenant_id: string;
  source_conversation_id: string;
  anchor_message_id: string;
  actor_id: string | null;
  /** Optional title override; defaults to "fork — <source>". */
  title?: string | null;
}

export interface ForkConversationResult {
  conversation: ConversationRecord;
  source_conversation_id: string;
  anchor_message_id: string;
  copied_message_count: number;
}

export async function forkConversation(
  p: ForkConversationParams,
  exec: Db,
): Promise<ForkConversationResult | null> {
  // Look up the source conversation + the anchor message in one trip
  // so we can validate (a) source exists (b) anchor belongs to it.
  const [source] = await exec
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.source_conversation_id)),
    );
  if (!source) return null;
  const [anchor] = await exec
    .select({ created_at: conversationMessages.created_at })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        eq(conversationMessages.conversation_id, p.source_conversation_id),
        eq(conversationMessages.id, p.anchor_message_id),
      ),
    );
  if (!anchor) return null;

  // Copy the source row's connector + workflow + draft + memory + model
  // verbatim. Status resets to "active". The fork starts with no loaded
  // skill catalog overrides — let the loop re-derive on next turn.
  const forkTitle = p.title ?? `fork — ${source.title ?? source.id.slice(0, 8)}`;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: source.target_connector_id,
      target_workflow_id: source.target_workflow_id,
      status: "active",
      draft: source.draft,
      owner_id: p.actor_id ?? source.owner_id ?? null,
      loaded_skills: source.loaded_skills,
      title: forkTitle,
      memory: source.memory,
      ...(source.model ? { model: source.model } : {}),
    })
    .returning();
  assertInsertRow(row, "conversations");

  // Copy every message with `created_at <= anchor.created_at`. We use
  // the timestamp window so concurrent appends to the source past the
  // anchor are excluded deterministically. New rows get fresh ids; the
  // `created_at` is set to "now" so the fork's timeline orders cleanly
  // even when the original messages spanned days.
  const messagesToCopy = await exec
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        eq(conversationMessages.conversation_id, p.source_conversation_id),
        lte(conversationMessages.created_at, anchor.created_at),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  let copiedCount = 0;
  if (messagesToCopy.length > 0) {
    await exec.insert(conversationMessages).values(
      messagesToCopy.map((m) => ({
        tenant_id: p.tenant_id,
        conversation_id: row.id,
        role: m.role,
        content: m.content,
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out,
      })),
    );
    copiedCount = messagesToCopy.length;
  }

  log.conversation.created({
    conversation_id: row.id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    connector_id: source.target_connector_id ?? null,
    workflow_id: source.target_workflow_id ?? null,
    has_initial_message: copiedCount > 0,
    memory_included: Boolean(source.memory),
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_CREATED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      metadata: {
        forked_from: p.source_conversation_id,
        anchor_message_id: p.anchor_message_id,
        copied_message_count: copiedCount,
      },
    },
    exec,
  );

  return {
    conversation: rowToRecord(row),
    source_conversation_id: p.source_conversation_id,
    anchor_message_id: p.anchor_message_id,
    copied_message_count: copiedCount,
  };
}
