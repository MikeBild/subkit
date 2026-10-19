import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction, ConversationDeletedMetadataSchema } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversationHidden,
  conversationMessages,
  conversations,
  fileLinks,
  mcpTasks,
  workflows,
} from "../../db/schema/index.ts";
import type { RequestSource } from "../../observability/service-metadata.ts";
import { now } from "../../utils/clock.ts";
import { cancelConversationAbort, hasConversationAbort } from "../abort.ts";
import { stringifyConversationExcerpt, truncateExcerpt } from "../excerpt.ts";
import type { ConversationOutcome } from "../lifecycle-view.ts";
import { deriveConversationOutcome } from "../lifecycle-view.ts";
import type { TurnFailure } from "../turn-failure.ts";
import { cancelConversationTurns } from "../turns.ts";
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
  actor_type?: "user" | "system_account" | "system" | "unknown",
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
      ...resolveActor({
        tenant_id,
        actor_id,
        actor_type: actor_type ?? (actor_id === null ? "system" : "unknown"),
      }),
      action: AuditAction.CONVERSATION_CANCELLED,
      resource_type: "conversation",
      resource_id: conversation_id,
      result: "success",
    },
    exec,
  );
  await cancelConversationTurns(exec, tenant_id, conversation_id);
  cancelConversationAbort(tenant_id, conversation_id);
  return rowToRecord(row);
}

export const PENDING_QUESTION_MAX = 2000;

export interface ListConversationsParams {
  tenant_id: string;
  status?: ConversationStatus;
  owner_id?: string;
  target_workflow_id?: string;
  target_connector_id?: string;
  q?: string;
  viewer_user_id?: string;
  hidden?: "exclude" | "only" | "all";
  owner_kind?: "user" | "system_account";
  sort?: "title" | "status" | "created_at" | "updated_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ConversationListItem extends ConversationRecord {
  last_message_role: string | null;
  last_message_excerpt: string | null;
  pending_elicitation_expires_at: string | null;
  pending_elicitation_summary: string | null;
  pending_elicitation_tool: string | null;
  last_activity_at: string | null;
  message_count: number;
  outcome: ConversationOutcome;
  owner: ConversationOwner | null;
  target_workflow: ConversationTargetRef | null;
  target_connector: ConversationTargetRef | null;
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

export async function isConversationHiddenFor(
  p: { tenant_id: string; conversation_id: string; user_id: string },
  exec: Db,
): Promise<boolean> {
  const rows = await exec
    .select({ conversation_id: conversationHidden.conversation_id })
    .from(conversationHidden)
    .where(
      and(
        eq(conversationHidden.tenant_id, p.tenant_id),
        eq(conversationHidden.conversation_id, p.conversation_id),
        eq(conversationHidden.user_id, p.user_id),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

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

const BACKGROUND_TURN_LIVE_MS = 600_000;

export type DeleteConversationResult =
  | { kind: "deleted"; id: string; title: string | null }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "turn_running" };

export async function deleteConversation(
  p: {
    tenant_id: string;
    conversation_id: string;
    actor_id: string;
    actor_type: "user" | "system_account" | "system";
    actor_is_admin: boolean;
    request_source: RequestSource;
  },
  exec: Db,
): Promise<DeleteConversationResult> {
  const [row] = await exec
    .select({ id: conversations.id, title: conversations.title, owner_id: conversations.owner_id })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (!p.actor_is_admin && row.owner_id !== p.actor_id) return { kind: "forbidden" };
  if (hasConversationAbort(p.tenant_id, p.conversation_id)) return { kind: "turn_running" };
  const [liveTask] = await exec
    .select({ id: mcpTasks.id })
    .from(mcpTasks)
    .where(
      and(
        eq(mcpTasks.tenant_id, p.tenant_id),
        eq(mcpTasks.conversation_id, p.conversation_id),
        isNull(mcpTasks.result),
        isNull(mcpTasks.failure_reason),
        isNull(mcpTasks.cancelled_at),
        or(
          gt(mcpTasks.created_at, new Date(now() - BACKGROUND_TURN_LIVE_MS)),
          gt(mcpTasks.parked_until, new Date(now())),
        ),
      ),
    )
    .limit(1);
  if (liveTask) return { kind: "turn_running" };

  await exec.transaction(async (tx) => {
    const [counted] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, p.tenant_id),
          eq(conversationMessages.conversation_id, p.conversation_id),
        ),
      );
    const links = await tx
      .delete(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, p.tenant_id),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, p.conversation_id),
        ),
      )
      .returning({ id: fileLinks.id });
    await tx
      .delete(conversations)
      .where(
        and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
      );
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_type,
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_DELETED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: ConversationDeletedMetadataSchema.parse({
          conversation_id: p.conversation_id,
          title: row.title,
          owner_id: row.owner_id,
          message_count: Number(counted?.n ?? 0),
          file_links_removed: links.length,
          request_source: p.request_source,
        }),
      },
      tx as unknown as Db,
    );
  });
  return { kind: "deleted", id: row.id, title: row.title };
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
  actor_type?: "user" | "system_account" | "system" | "unknown";
  model?: string | null;
  title?: string | null;
}

export async function patchConversation(
  p: PatchConversationParams,
  exec: Db,
): Promise<ConversationRecord | null> {
  const updates: Partial<typeof conversations.$inferInsert> = { updated_at: new Date(now()) };
  if (p.model !== undefined) updates.model = p.model;
  if (p.title !== undefined) {
    updates.title = p.title;
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
      ...resolveActor({
        tenant_id: p.tenant_id,
        actor_id: p.actor_id,
        ...(p.actor_type ? { actor_type: p.actor_type } : {}),
      }),
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

export async function recordConversationTurnFailure(
  exec: Db,
  tenant_id: string,
  conversation_id: string,
  failure: TurnFailure,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ last_turn_error: failure })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
}

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
