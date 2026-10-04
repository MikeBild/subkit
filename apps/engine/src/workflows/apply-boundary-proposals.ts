import type { Executor } from "../db/client.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { proposeBoundaries } from "./boundary-proposal.ts";
import { getWorkflowDraft, type SaveWorkflowDraftResult, saveWorkflowDraft } from "./drafts.ts";
import { getWorkflow } from "./service.ts";
import type { WorkflowDef } from "./types.ts";

export async function currentOrDraftDefinition(
  tenant_id: string,
  workflow_id: string,
  db: Executor,
): Promise<WorkflowDef | null> {
  const draft = await getWorkflowDraft(tenant_id, workflow_id, db);
  if (draft) return draft.definition;
  const workflow = await getWorkflow(tenant_id, workflow_id, db);
  return workflow?.definition ?? null;
}

export type ApplyBoundaryProposalsResult =
  | { draft: NonNullable<SaveWorkflowDraftResult["draft"]>; applied_step_ids: string[] }
  | { draft?: never; code: "nothing_to_apply" }
  | SaveWorkflowDraftResult;

export async function applyBoundaryProposals(
  input: {
    tenant_id: string;
    workflow_id: string;
    expected_draft_version_id: string | null;
    step_ids?: string[];
    actor_id: string | null;
    actor_type?: "user" | "system_account" | "system";
    request_source: RequestSource;
  },
  db: Executor,
): Promise<ApplyBoundaryProposalsResult> {
  const definition = await currentOrDraftDefinition(input.tenant_id, input.workflow_id, db);
  if (!definition) return { code: "not_found", errors: ["workflow not found"] };
  const { proposals } = await proposeBoundaries(db, {
    tenant_id: input.tenant_id,
    workflow_id: input.workflow_id,
    definition,
  });
  const wanted = input.step_ids ? new Set(input.step_ids) : null;
  const chosen = proposals.filter((entry) => !wanted || wanted.has(entry.step_id));
  if (chosen.length === 0) return { code: "nothing_to_apply" };
  const byStep = new Map(chosen.map((entry) => [entry.step_id, entry]));
  const applied: string[] = [];
  const steps = definition.steps.map((step) => {
    const proposal = byStep.get(step.id);
    if (!proposal || step.kind !== "request") return step;
    applied.push(step.id);
    if (proposal.s3_scope && step.s3)
      return { ...step, s3: { ...step.s3, scope: proposal.s3_scope } };
    const paged =
      proposal.max_pages !== undefined && step.pagination
        ? { pagination: { ...step.pagination, max_pages: proposal.max_pages } }
        : {};
    const rewritten = proposal.path_rewrite
      ? { path: proposal.path_rewrite.path, query: proposal.path_rewrite.query }
      : {};
    if (proposal.boundary) return { ...step, ...paged, ...rewritten, boundary: proposal.boundary };
    return { ...step, ...paged, ...rewritten };
  });
  const result = await saveWorkflowDraft(
    {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      expected_draft_version_id: input.expected_draft_version_id,
      def: { ...definition, steps },
      actor_id: input.actor_id,
      ...(input.actor_type ? { actor_type: input.actor_type } : {}),
      request_source: input.request_source,
      audit_metadata: {
        reason: "boundary_proposals_applied",
        derived_from_history: true,
        applied_step_ids: applied,
      },
    },
    db,
  );
  return result.draft ? { draft: result.draft, applied_step_ids: applied } : result;
}
