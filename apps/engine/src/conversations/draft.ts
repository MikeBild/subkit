// Draft document CRUD + snapshot history.
//
// Every mutation (`propose_step`, `update_param`, `connect_steps`)
// writes a new row into `conversation_drafts` with an incrementing
// ordinal. The newest ordinal is the live draft; :undo pops the top.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  conversationDrafts,
  conversations,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  normalizeDraftDocument,
} from "./authoring-state.ts";
import type { DraftDocument } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function emptyDraft(): DraftDocument {
  return createEmptyDraftDocument();
}

function padOrdinal(n: number): string {
  return n.toString().padStart(6, "0");
}

async function hydrateBoundWorkflow(
  tenant_id: string,
  target_workflow_id: string | null,
  draft: DraftDocument,
  exec: Executor,
): Promise<DraftDocument> {
  const normalized = normalizeDraftDocument(draft);
  if (!target_workflow_id) return normalized;
  if (
    normalized.summary?.persisted_resources.some(
      (resource) => resource.kind === "workflow" && resource.id === target_workflow_id,
    )
  ) {
    return normalized;
  }
  const alreadyBoundWithIdentity =
    normalized.summary?.active_target.kind === "workflow" &&
    normalized.summary.active_target.id === target_workflow_id &&
    (normalized.summary.active_target.name !== null ||
      normalized.summary.active_target.slug !== null);
  if (alreadyBoundWithIdentity) {
    return normalized;
  }
  const workflowRows = await exec
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
      updated_at: workflows.updated_at,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, target_workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const workflow = workflowRows[0];
  if (!workflow) return normalized;
  let version: number | null = null;
  if (workflow.current_version_id) {
    const versionRows = await exec
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.id, workflow.current_version_id),
        ),
      )
      .limit(1);
    version = versionRows[0]?.version ?? null;
  }
  return bindPersistedWorkflow(normalized, {
    kind: "workflow",
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    version_id: workflow.current_version_id,
    version,
    environment: null,
    saved_at: workflow.updated_at.toISOString(),
  });
}

/**
 * Load the live draft for a conversation. Returns a fresh empty
 * document if none exists yet.
 */
export async function loadDraft(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<DraftDocument> {
  const conversationRows = await exec
    .select({
      draft: conversations.draft,
      target_workflow_id: conversations.target_workflow_id,
    })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  const conversation = conversationRows[0];
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Fall back to the `conversations.draft` column in case a caller
    // seeded it via the service.
    const draft = conversation?.draft;
    if (draft && typeof draft === "object") {
      return hydrateBoundWorkflow(
        tenant_id,
        conversation?.target_workflow_id ?? null,
        normalizeDraftDocument(draft),
        exec,
      );
    }
    return hydrateBoundWorkflow(
      tenant_id,
      conversation?.target_workflow_id ?? null,
      emptyDraft(),
      exec,
    );
  }
  return hydrateBoundWorkflow(
    tenant_id,
    conversation?.target_workflow_id ?? null,
    normalizeDraftDocument(row.snapshot),
    exec,
  );
}

/**
 * Append a new snapshot. `mutate` receives the current draft and
 * returns the new one — mutating in place is fine because we clone
 * the argument first.
 */
export async function appendSnapshot(
  tenant_id: string,
  conversation_id: string,
  draft: DraftDocument,
  exec: Executor,
): Promise<void> {
  // Ordinal is monotonic — compute as count + 1 over the live set.
  const [row] = (await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationDrafts)
    .where(eq(conversationDrafts.conversation_id, conversation_id))) as Array<{ n: number }>;
  const next = (row?.n ?? 0) + 1;
  const normalized = normalizeDraftDocument(draft);
  await exec.insert(conversationDrafts).values({
    tenant_id,
    conversation_id,
    ordinal: padOrdinal(next),
    snapshot: normalized as unknown as Record<string, unknown>,
  });
  // Mirror to conversations.draft for easy reads.
  await exec
    .update(conversations)
    .set({ draft: normalized as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
}

/**
 * Pop the most recent snapshot, restoring the previous one. Returns
 * the now-current draft (or the empty draft if the history is empty).
 */
export async function undoLastSnapshot(
  tenant_id: string,
  conversation_id: string,
  exec: Executor,
): Promise<DraftDocument> {
  const rows = await exec
    .select()
    .from(conversationDrafts)
    .where(
      and(
        eq(conversationDrafts.tenant_id, tenant_id),
        eq(conversationDrafts.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationDrafts.ordinal));
  if (rows.length === 0) return emptyDraft();
  const head = rows[0];
  if (!head) return emptyDraft();
  await exec.delete(conversationDrafts).where(eq(conversationDrafts.id, head.id));
  const next = rows[1];
  const draft = normalizeDraftDocument(
    (next?.snapshot as DraftDocument | undefined) ?? emptyDraft(),
  );
  await exec
    .update(conversations)
    .set({ draft: draft as unknown as Record<string, unknown>, updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)));
  return draft;
}
