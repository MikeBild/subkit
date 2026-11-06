import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  fileLinks,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";

export interface ConversationScope {
  readonly tenant_id: string;
  readonly conversation_id: string;
}

export type LoadedSkillEntries = Array<{ slug: string; last_turn: number }>;

function conversationRow(scope: ConversationScope) {
  return and(
    eq(conversations.tenant_id, scope.tenant_id),
    eq(conversations.id, scope.conversation_id),
  );
}

export async function setConversationWorkflowTarget(
  db: Executor,
  scope: ConversationScope,
  target_workflow_id: string | null,
): Promise<void> {
  await db
    .update(conversations)
    .set({ target_workflow_id, updated_at: new Date() })
    .where(conversationRow(scope));
}

export async function readConversationSkillState(
  db: Executor,
  scope: ConversationScope,
): Promise<{ loaded_skills: LoadedSkillEntries; turn_count: number } | undefined> {
  const [row] = await db
    .select({ loaded_skills: conversations.loaded_skills, turn_count: conversations.turn_count })
    .from(conversations)
    .where(conversationRow(scope))
    .limit(1);
  return row;
}

export async function setConversationLoadedSkills(
  db: Executor,
  scope: ConversationScope,
  loaded_skills: LoadedSkillEntries,
): Promise<void> {
  await db.update(conversations).set({ loaded_skills }).where(conversationRow(scope));
}

export async function readConversationPlaybookMode(
  db: Executor,
  scope: ConversationScope,
): Promise<string | null> {
  const [row] = await db
    .select({ mode: conversations.playbook_mode })
    .from(conversations)
    .where(conversationRow(scope))
    .limit(1);
  return row?.mode ?? null;
}

export async function readConversationTargets(
  db: Executor,
  scope: ConversationScope,
): Promise<{ target_connector_id: string | null; target_workflow_id: string | null } | undefined> {
  const [row] = await db
    .select({
      target_connector_id: conversations.target_connector_id,
      target_workflow_id: conversations.target_workflow_id,
    })
    .from(conversations)
    .where(conversationRow(scope))
    .limit(1);
  return row;
}

export async function listRecentSuccessfulToolCalls(
  db: Executor,
  scope: ConversationScope,
  limit: number,
): Promise<Array<{ id: string; tool: string; observed_at: Date }>> {
  return db
    .select({
      id: conversationToolCalls.id,
      tool: conversationToolCalls.tool,
      observed_at: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, scope.tenant_id),
        eq(conversationToolCalls.conversation_id, scope.conversation_id),
        eq(conversationToolCalls.outcome, "ok"),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(limit);
}

export async function listRecentToolCallOutputs(
  db: Executor,
  scope: ConversationScope,
  limit: number,
): Promise<Array<{ tool: string; output: unknown }>> {
  return db
    .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, scope.tenant_id),
        eq(conversationToolCalls.conversation_id, scope.conversation_id),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(limit);
}

export interface AuthoringContextCounts {
  readonly messages: number;
  readonly tool_calls: number;
  readonly attachments: number;
  readonly pending_elicitations: number;
}

export async function countAuthoringContext(
  db: Executor,
  scope: ConversationScope,
): Promise<AuthoringContextCounts> {
  const [messageCount, toolCallCount, attachmentCount, pendingCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, scope.tenant_id),
          eq(conversationMessages.conversation_id, scope.conversation_id),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, scope.tenant_id),
          eq(conversationToolCalls.conversation_id, scope.conversation_id),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, scope.tenant_id),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, scope.conversation_id),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, scope.tenant_id),
          eq(conversationElicitations.conversation_id, scope.conversation_id),
          eq(conversationElicitations.status, "pending"),
        ),
      ),
  ]);
  return {
    messages: messageCount[0]?.count ?? 0,
    tool_calls: toolCallCount[0]?.count ?? 0,
    attachments: attachmentCount[0]?.count ?? 0,
    pending_elicitations: pendingCount[0]?.count ?? 0,
  };
}

export async function readTargetWorkflowActiveDag(
  db: Executor,
  scope: ConversationScope,
): Promise<{ dag: unknown; slug: string } | undefined> {
  const [row] = await db
    .select({ dag: workflowVersions.dag, slug: workflows.slug })
    .from(conversations)
    .innerJoin(
      workflows,
      and(
        eq(workflows.tenant_id, conversations.tenant_id),
        eq(workflows.id, conversations.target_workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, workflows.tenant_id),
        eq(workflowVersions.workflow_id, workflows.id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(conversationRow(scope))
    .limit(1);
  return row;
}
