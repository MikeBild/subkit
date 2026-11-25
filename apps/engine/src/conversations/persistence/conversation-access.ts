import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import { conversations, type Executor, isTaskRunConversation } from "../../db/index.ts";
import { can } from "../../rbac/index.ts";
import {
  type ConversationAccessRow,
  type ConversationViewer,
  canReadConversation,
  conversationAccessRowOf,
  conversationViewerOf,
} from "../core/access.ts";
import { getTaskRunMarker } from "../core/draft.ts";
import type { TaskRunMarker } from "../types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONVERSATION_GET_PERMISSIONS = [
  "conversation:read",
  "workflow:read",
  "conversation:approve",
  "workflow:write",
] as const;

export interface ConversationAccessFacts {
  readonly row: ConversationAccessRow;
  readonly marker: TaskRunMarker | null;
}

export async function loadConversationAccess(
  exec: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<ConversationAccessFacts | null> {
  if (!UUID.test(conversation_id)) return null;
  const [row] = await exec
    .select({
      tenant_id: conversations.tenant_id,
      owner_id: conversations.owner_id,
      visibility: conversations.visibility,
      draft: conversations.draft,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  if (!row) return null;
  return { row: conversationAccessRowOf(row), marker: getTaskRunMarker(row.draft) };
}

export interface ConversationReader {
  tenant_id: string;
  conversation_id: string;
  principal: ResolvedPrincipal | null | undefined;
}

export async function isConversationReadable(
  exec: Executor,
  reader: ConversationReader,
): Promise<boolean> {
  const facts = await loadConversationAccess(exec, reader.tenant_id, reader.conversation_id);
  if (!facts) return true;
  const principal = reader.principal;
  if (!principal || principal.tenant_id !== reader.tenant_id) return false;
  return canReadConversation(conversationViewerOf(principal), facts.row);
}

async function holdsConversationGetPermission(
  exec: Executor,
  principal: ResolvedPrincipal,
): Promise<boolean> {
  for (const permission of CONVERSATION_GET_PERMISSIONS) {
    const decision = await can(exec, { tenant_id: principal.tenant_id, principal, permission });
    if (decision.allow) return true;
  }
  return false;
}

export async function hidesConversationFromReader(
  exec: Executor,
  reader: ConversationReader & { principal: ResolvedPrincipal },
): Promise<boolean> {
  if (await isConversationReadable(exec, reader)) return false;
  return holdsConversationGetPermission(exec, reader.principal);
}

function taskRunSealed(): SQL<boolean> {
  return sql<boolean>`(jsonb_typeof(${conversations.draft} -> 'session' -> 'task_run') <> 'object' or jsonb_exists(${conversations.draft} -> 'session' -> 'task_run', 'sealed'))`;
}

export function conversationReaderCond(viewer: ConversationViewer): SQL<boolean> {
  const owned = eq(conversations.owner_id, viewer.id);
  const taskRunBranch = viewer.is_admin
    ? sql<boolean>`true`
    : sql<boolean>`(not ${taskRunSealed()} and ${owned})`;
  const plainBranch = or(
    owned,
    eq(conversations.visibility, "team"),
    ...(viewer.is_admin ? [isNull(conversations.owner_id)] : []),
  );
  return sql<boolean>`(${eq(conversations.tenant_id, viewer.tenant_id)} and case when ${isTaskRunConversation()} then ${taskRunBranch} else coalesce(${plainBranch}, false) end)`;
}
