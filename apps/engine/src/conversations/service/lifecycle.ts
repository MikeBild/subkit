// Conversation lifecycle endpoints — cancel, list, patch metadata.

import { and, desc, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { stripFileSentinelsForDisplay } from "../../files/sentinel.ts";
import { now } from "../../utils/clock.ts";
import { cancelConversationAbort } from "../abort.ts";
import type { ConversationRecord, ConversationStatus } from "../types.ts";
import { rowToRecord } from "./shared.ts";

export async function cancelConversation(
  tenant_id: string,
  conversation_id: string,
  actor_id: string | null,
  exec: Db,
): Promise<ConversationRecord | null> {
  const [row] = await exec
    .update(conversations)
    .set({ status: "abandoned", updated_at: new Date(now()) })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
      action: AuditAction.CONVERSATION_CANCELLED,
      resource_type: "conversation",
      resource_id: conversation_id,
      result: "success",
    },
    exec,
  );
  cancelConversationAbort(tenant_id, conversation_id);
  return rowToRecord(row);
}

export interface ListConversationsParams {
  tenant_id: string;
  status?: ConversationStatus;
  /** Restrict to conversations owned by this user id. */
  owner_id?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationListItem extends ConversationRecord {
  last_message_role: string | null;
  last_message_excerpt: string | null;
}

function stringifyConversationExcerpt(content: unknown): string | null {
  // Human-facing excerpt — strip every `[file:fid_<uuid>]` sentinel to
  // a `[file]` placeholder so the raw fid never lands in a UI list or
  // notification body. The conversation list is rendered to operators;
  // a leaked sentinel is both unreadable and a low-grade information
  // disclosure (the fid is tenant-scoped but still an internal id).
  const stripped = (raw: string): string => stripFileSentinelsForDisplay(raw);
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? stripped(trimmed) : null;
  }
  if (content === null || content === undefined) return null;
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string" && obj.text.trim().length > 0) {
      return stripped(obj.text.trim());
    }
    if (typeof obj.summary === "string" && obj.summary.trim().length > 0) {
      return stripped(obj.summary.trim());
    }
  }
  try {
    const raw = JSON.stringify(content);
    return raw.length > 2 ? stripped(raw) : null;
  } catch {
    return stripped(String(content));
  }
}

function truncateExcerpt(text: string, max = 140): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  return `${squashed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export async function listConversations(
  p: ListConversationsParams,
  exec: Db,
): Promise<ConversationListItem[]> {
  const tenantConds = [eq(conversations.tenant_id, p.tenant_id)];
  if (p.status) tenantConds.push(eq(conversations.status, p.status));
  if (p.owner_id) tenantConds.push(eq(conversations.owner_id, p.owner_id));
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(...tenantConds))
    .orderBy(desc(conversations.updated_at))
    .limit(Math.min(p.limit ?? 50, 200))
    .offset(p.offset ?? 0);
  if (rows.length === 0) return [];

  const conversationIds = rows.map((row) => row.id);
  const messages = await exec
    .select({
      conversation_id: conversationMessages.conversation_id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, p.tenant_id),
        inArray(conversationMessages.conversation_id, conversationIds),
      ),
    )
    .orderBy(desc(conversationMessages.created_at));

  const latestByConversation = new Map<string, { role: string | null; excerpt: string | null }>();
  for (const message of messages) {
    if (latestByConversation.has(message.conversation_id)) continue;
    const excerpt = stringifyConversationExcerpt(message.content);
    if (!excerpt) continue;
    latestByConversation.set(message.conversation_id, {
      role: message.role,
      excerpt: truncateExcerpt(excerpt),
    });
  }

  return rows.map((row) => {
    const latest = latestByConversation.get(row.id);
    return {
      ...rowToRecord(row),
      last_message_role: latest?.role ?? null,
      last_message_excerpt: latest?.excerpt ?? null,
    };
  });
}

export interface PatchConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  model?: string | null;
  title?: string | null;
}

/**
 * Patch a conversation's mutable metadata. Emits `CONVERSATION_UPDATED`
 * audit. The conversation rows's `updated_at` is bumped so the
 * `/resume` picker re-orders against it.
 */
export async function patchConversation(
  p: PatchConversationParams,
  exec: Db,
): Promise<ConversationRecord | null> {
  const updates: Partial<typeof conversations.$inferInsert> = { updated_at: new Date(now()) };
  if (p.model !== undefined) updates.model = p.model;
  if (p.title !== undefined) updates.title = p.title;
  const [row] = await exec
    .update(conversations)
    .set(updates)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_UPDATED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: {
        model: p.model ?? null,
        title: p.title ?? null,
      },
    },
    exec,
  );
  return rowToRecord(row);
}
