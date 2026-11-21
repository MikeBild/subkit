import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { authoringCapabilitySignal } from "../../skill-candidates/authoring-capability.ts";
import { upsertFromSignal } from "../../skill-candidates/service.ts";
import type { ScopeIndex, WorkflowDefFromDraft } from "./commit-workflow.ts";

export async function proposeAuthoringCapabilityCandidate(args: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  workflow: { id: string; slug: string; name: string };
  def: WorkflowDefFromDraft;
  scope_index: ScopeIndex;
  draft_version_id?: string;
}): Promise<void> {
  const { db, tenant_id, conversation_id, workflow, def, scope_index } = args;
  try {
    const signal = authoringCapabilitySignal({
      workflow_id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      def,
      scope_index,
      ...(args.draft_version_id ? { draft_version_id: args.draft_version_id } : {}),
    });
    await upsertFromSignal(tenant_id, signal, db);
  } catch (err) {
    logger.warn({
      module: "conversation_persistence",
      action: "commit.skill_candidate_failed",
      msg: "capability skill-candidate proposal failed — commit is unaffected",
      tenant_id,
      conversation_id,
      workflow_id: workflow.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
