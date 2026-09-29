// Conversation lifecycle endpoints — cancel, list, patch metadata.

import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversationHidden,
  conversationMessages,
  conversations,
  workflows,
} from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import { cancelConversationAbort } from "../abort.ts";
import { stringifyConversationExcerpt, truncateExcerpt } from "../excerpt.ts";
import type { ConversationOutcome } from "../lifecycle-view.ts";
import { deriveConversationOutcome } from "../lifecycle-view.ts";
import type {
  ConversationOwner,
  ConversationRecord,
  ConversationStatus,
  ConversationTargetRef,
} from "../types.ts";
import { loadOwners, rowToRecord } from "./shared.ts";

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
  /** The person reading the list — needed for `hidden` and the `hidden` flag. */
  viewer_user_id?: string;
  /** Default `exclude` when a viewer is known: a hidden conversation stays out of the way. */
  hidden?: "exclude" | "only" | "all";
  /** Restrict to conversations owned by people or by machine accounts. */
  owner_kind?: "user" | "system_account";
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
  /** Newest message time — the activity clock the list sorts and ages by;
   *  `updated_at` also moves on bookkeeping writes and is not that. */
  last_activity_at: string | null;
  message_count: number;
  /** Read-time projection of status + last message — see `lifecycle-view.ts`. */
  outcome: ConversationOutcome;
  owner: ConversationOwner | null;
  target_workflow: ConversationTargetRef | null;
  target_connector: ConversationTargetRef | null;
  /** Hidden by the calling person. Only meaningful when the list ran with a viewer. */
  hidden: boolean;
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
  if (p.viewer_user_id && p.hidden !== "all") {
    const hiddenForViewer = sql<boolean>`exists (
      select 1 from conversation_hidden ch
      where ch.tenant_id = ${p.tenant_id}
        and ch.conversation_id = ${conversations.id}
        and ch.user_id = ${p.viewer_user_id}
    )`;
    tenantConds.push(p.hidden === "only" ? hiddenForViewer : sql`not ${hiddenForViewer}`);
  }
  if (p.owner_kind === "user") {
    tenantConds.push(
      sql`exists (select 1 from users u where u.tenant_id = ${p.tenant_id} and u.id = ${conversations.owner_id})`,
    );
  } else if (p.owner_kind === "system_account") {
    tenantConds.push(
      sql`exists (select 1 from system_accounts sa where sa.tenant_id = ${p.tenant_id} and sa.id = ${conversations.owner_id})`,
    );
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
  // Activity clock and size, from the same rows: the newest message of any
  // role (tool rows count — a turn that died mid-way is still activity) and
  // how many there are.
  const activity = new Map<string, { last_role: string; last_at: Date; count: number }>();
  for (const message of messages) {
    const seen = activity.get(message.conversation_id);
    if (seen) seen.count += 1;
    else
      activity.set(message.conversation_id, {
        last_role: message.role,
        last_at: message.created_at,
        count: 1,
      });
    if (latestByConversation.has(message.conversation_id)) continue;
    const excerpt = stringifyConversationExcerpt(message.content);
    if (!excerpt) continue;
    latestByConversation.set(message.conversation_id, {
      role: message.role,
      excerpt: truncateExcerpt(excerpt),
    });
  }

  const [owners, targetWorkflows, targetConnectors, hiddenRows] = await Promise.all([
    loadOwners(
      p.tenant_id,
      rows.map((row) => row.owner_id),
      exec,
    ),
    loadTargetWorkflows(
      p.tenant_id,
      rows.map((row) => row.target_workflow_id),
      exec,
    ),
    loadTargetConnectors(
      p.tenant_id,
      rows.map((row) => row.target_connector_id),
      exec,
    ),
    p.viewer_user_id
      ? exec
          .select({ conversation_id: conversationHidden.conversation_id })
          .from(conversationHidden)
          .where(
            and(
              eq(conversationHidden.tenant_id, p.tenant_id),
              eq(conversationHidden.user_id, p.viewer_user_id),
              inArray(conversationHidden.conversation_id, conversationIds),
            ),
          )
      : Promise.resolve([] as Array<{ conversation_id: string }>),
  ]);
  const hiddenIds = new Set(hiddenRows.map((row) => row.conversation_id));
  const nowMs = now();

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
    const act = activity.get(row.id);
    const lastActivityAt = act ? act.last_at.toISOString() : null;
    return {
      ...rowToRecord(row),
      last_message_role: latest?.role ?? null,
      last_message_excerpt: latest?.excerpt ?? null,
      last_activity_at: lastActivityAt,
      message_count: act?.count ?? 0,
      outcome: deriveConversationOutcome({
        status: row.status,
        last_message_role: act?.last_role ?? null,
        last_activity_at: lastActivityAt,
        last_turn_error: row.last_turn_error ?? null,
        now: nowMs,
      }),
      owner: (row.owner_id && owners.get(row.owner_id)) || null,
      target_workflow:
        (row.target_workflow_id && targetWorkflows.get(row.target_workflow_id)) || null,
      target_connector:
        (row.target_connector_id && targetConnectors.get(row.target_connector_id)) || null,
      hidden: hiddenIds.has(row.id),
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

async function loadTargetWorkflows(
  tenant_id: string,
  ids: Array<string | null>,
  exec: Db,
): Promise<Map<string, ConversationTargetRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const out = new Map<string, ConversationTargetRef>();
  if (wanted.length === 0) return out;
  const rows = await exec
    .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), inArray(workflows.id, wanted)));
  for (const r of rows) out.set(r.id, { id: r.id, slug: r.slug, name: r.name });
  return out;
}

async function loadTargetConnectors(
  tenant_id: string,
  ids: Array<string | null>,
  exec: Db,
): Promise<Map<string, ConversationTargetRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const out = new Map<string, ConversationTargetRef>();
  if (wanted.length === 0) return out;
  const rows = await exec
    .select({ id: connectors.id, slug: connectors.slug, name: connectors.display_name })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), inArray(connectors.id, wanted)));
  for (const r of rows) out.set(r.id, { id: r.id, slug: r.slug, name: r.name });
  return out;
}

/**
 * Take a conversation out of one person's list, or put it back. Never a
 * delete: the row, its messages, tool calls and audit trail stay, and every
 * other reader still sees it. Returns null when the conversation is not in
 * the tenant.
 */
export async function setConversationHidden(
  p: { tenant_id: string; conversation_id: string; user_id: string; hidden: boolean },
  exec: Db,
): Promise<ConversationRecord | null> {
  const [row] = await exec
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  if (!row) return null;
  if (p.hidden) {
    await exec
      .insert(conversationHidden)
      .values({ tenant_id: p.tenant_id, conversation_id: p.conversation_id, user_id: p.user_id })
      .onConflictDoNothing();
  } else {
    await exec
      .delete(conversationHidden)
      .where(
        and(
          eq(conversationHidden.tenant_id, p.tenant_id),
          eq(conversationHidden.conversation_id, p.conversation_id),
          eq(conversationHidden.user_id, p.user_id),
        ),
      );
  }
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "user",
      actor_id: p.user_id,
      action: p.hidden ? AuditAction.CONVERSATION_HIDDEN : AuditAction.CONVERSATION_UNHIDDEN,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
    },
    exec,
  );
  return rowToRecord(row);
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
  if (p.title !== undefined) {
    updates.title = p.title;
    // A name a person set is theirs; the automatic titler stays off it.
    updates.title_locked = typeof p.title === "string" && p.title.trim().length > 0;
  }
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

/**
 * Remember why the last turn stopped, when it stopped because something broke.
 *
 * A turn killed by a provider error wrote nothing at all: the status stayed
 * `active`, no message was appended, and the transcript read "in progress" for
 * as long as anyone cared to look — indistinguishable from a turn still
 * thinking. The provider's own sentence ("you have reached your specified API
 * usage limits") is usually the whole diagnosis, and it was discarded twice
 * over: once by not being stored, once by the browser replacing it with a
 * constant.
 *
 * Stored on the conversation, never as a message. A synthetic assistant turn
 * would be replayed to the model as something the assistant said.
 */
export async function recordConversationTurnFailure(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
  failure: { code: string; message: string; at: string; kind?: string; retry_at?: string },
): Promise<void> {
  await exec
    .update(conversations)
    .set({ last_turn_error: failure })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
}

/** Forget it: the next turn has started, so the old failure is history. */
export async function clearConversationTurnFailure(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ last_turn_error: null })
    .where(
      and(
        eq(conversations.tenant_id, tenant_id),
        eq(conversations.id, conversation_id),
        isNotNull(conversations.last_turn_error),
      ),
    );
}
