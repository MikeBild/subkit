// Conversation lifecycle endpoints — cancel, list, patch metadata.

import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
} from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import { cancelConversationAbort } from "../abort.ts";
import { stringifyConversationExcerpt, truncateExcerpt } from "../excerpt.ts";
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

/**
 * Payload guard on the question a waiting conversation carries.
 *
 * Not a display length — see the note at the call site. Sized against the real
 * distribution (longest pending prompt in production: 482 characters) so that
 * clipping here means a tool call went wrong, not that a person wrote a long
 * question.
 */
export const PENDING_QUESTION_MAX = 2000;

export interface ListConversationsParams {
  tenant_id: string;
  status?: ConversationStatus;
  /** Restrict to conversations owned by this user id. */
  owner_id?: string;
  target_workflow_id?: string;
  target_connector_id?: string;
  q?: string;
  sort?: "title" | "status" | "created_at" | "updated_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ConversationListItem extends ConversationRecord {
  last_message_role: string | null;
  last_message_excerpt: string | null;
  /** When this conversation's pending prompt lapses, or null when nothing is
   *  waiting. The only real deadline in the product — a review queue cannot
   *  tell "running out" from "just sitting there" without it. */
  pending_elicitation_expires_at: string | null;
  /** What the conversation is actually asking. A queue that says only "waiting
   *  for your answer" asks a person to open every entry to find out which one
   *  they can answer; the question is the thing that lets them choose. */
  pending_elicitation_summary: string | null;
  /** Which `ask_user_*` raised it — a confirmation reads differently from a
   *  free-text question, and the queue can say so without opening anything. */
  pending_elicitation_tool: string | null;
}

function conversationListConds(p: ListConversationsParams) {
  const tenantConds = [eq(conversations.tenant_id, p.tenant_id)];
  if (p.status) tenantConds.push(eq(conversations.status, p.status));
  if (p.owner_id) tenantConds.push(eq(conversations.owner_id, p.owner_id));
  if (p.target_workflow_id) {
    tenantConds.push(eq(conversations.target_workflow_id, p.target_workflow_id));
  }
  if (p.target_connector_id) {
    tenantConds.push(eq(conversations.target_connector_id, p.target_connector_id));
  }
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(conversations.title, needle),
      sql<boolean>`exists (
        select 1 from conversation_messages cm
        where cm.tenant_id = ${p.tenant_id}
          and cm.conversation_id = ${conversations.id}
          and cm.content::text ilike ${needle}
      )`,
    );
    if (search) tenantConds.push(search);
  }
  return tenantConds;
}

export async function listConversations(
  p: ListConversationsParams,
  exec: Db,
): Promise<ConversationListItem[]> {
  const tenantConds = conversationListConds(p);
  const sortColumn =
    p.sort === "title"
      ? conversations.title
      : p.sort === "status"
        ? conversations.status
        : p.sort === "created_at"
          ? conversations.created_at
          : conversations.updated_at;
  const ordered = p.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(...tenantConds))
    .orderBy(ordered, asc(conversations.id))
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

  // The pending prompt a waiting conversation is running out of, AND what it
  // asks. One query for the whole page, served by the existing
  // `(conversation_id, status)` index — deliberately NOT a join onto the main
  // select, which would multiply rows against a 1:N table and break the
  // limit/offset pagination that `countConversations` is paired with.
  //
  // `distinct on` rather than `min(expires_at)`: the deadline alone answered
  // "how long have I got" but not "got for what", and the question lives on the
  // same row. The ordering picks the prompt that lapses first — the one that
  // actually bites — and carries its own summary and tool with it.
  const pendingRows = await exec
    .selectDistinctOn([conversationElicitations.conversation_id], {
      conversation_id: conversationElicitations.conversation_id,
      expires_at: conversationElicitations.expires_at,
      summary: conversationElicitations.summary,
      tool_name: conversationElicitations.tool_name,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        inArray(conversationElicitations.conversation_id, conversationIds),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .orderBy(conversationElicitations.conversation_id, asc(conversationElicitations.expires_at));
  const pendingByConversation = new Map(pendingRows.map((row) => [row.conversation_id, row]));

  return rows.map((row) => {
    const latest = latestByConversation.get(row.id);
    const pending = pendingByConversation.get(row.id);
    return {
      ...rowToRecord(row),
      last_message_role: latest?.role ?? null,
      last_message_excerpt: latest?.excerpt ?? null,
      pending_elicitation_expires_at: pending ? pending.expires_at.toISOString() : null,
      // The whole question, not an excerpt of it. Clipping at 140 here made the
      // decision queue's expanded panel show the reader exactly what its
      // collapsed line already showed — the caller could not recover what the
      // engine had thrown away. How much of a question fits on a card is a
      // decision the surface makes, so the surface gets the text and makes it.
      //
      // The bound that remains is a payload guard, not a display rule: it is
      // wide enough that no real question meets it (the longest pending prompt
      // in production is a third of it) and narrow enough that one malformed
      // tool call cannot inflate a 200-row page.
      pending_elicitation_summary: pending?.summary
        ? truncateExcerpt(pending.summary, PENDING_QUESTION_MAX)
        : null,
      pending_elicitation_tool: pending?.tool_name ?? null,
    };
  });
}

export async function countConversations(p: ListConversationsParams, exec: Db): Promise<number> {
  const [row] = await exec
    .select({ total: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(...conversationListConds(p)));
  return Number(row?.total ?? 0);
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
