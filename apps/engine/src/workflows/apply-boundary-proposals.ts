import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Executor } from "../db/client.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { type BoundaryProposals, proposeBoundaries } from "./boundary-proposal.ts";
import { workflowJsonDigest } from "./canonical-json.ts";
import { applyStepProposal } from "./core/boundary-derivation.ts";
import { getWorkflowDraft, type SaveWorkflowDraftResult, saveWorkflowDraft } from "./drafts.ts";
import { getWorkflow } from "./service.ts";
import type { WorkflowDef } from "./types.ts";

interface ReviewedDefinition {
  definition: WorkflowDef;
  version_id: string | null;
  draft_version_id: string | null;
}

export interface BoundaryProposalRead extends BoundaryProposals {
  digest: string;
  base_version_id: string | null;
  draft_version_id: string | null;
}

export async function reviewedDefinition(
  tenant_id: string,
  workflow_id: string,
  db: Executor,
): Promise<ReviewedDefinition | null> {
  const draft = await getWorkflowDraft(tenant_id, workflow_id, db);
  if (draft)
    return {
      definition: draft.definition,
      version_id: draft.version_id,
      draft_version_id: draft.version_id,
    };
  const workflow = await getWorkflow(tenant_id, workflow_id, db);
  return workflow
    ? {
        definition: workflow.definition,
        version_id: workflow.current_version_id ?? null,
        draft_version_id: null,
      }
    : null;
}

function proposalsDigest(derived: BoundaryProposals, environment: "dev" | "prod"): string {
  return workflowJsonDigest({
    environment,
    proposals: derived.proposals.map(
      ({ step_id, boundary, max_pages, path_rewrite, s3_scope }) => ({
        step_id,
        boundary: boundary ?? null,
        max_pages: max_pages ?? null,
        path_rewrite: path_rewrite ?? null,
        s3_scope: s3_scope ?? null,
      }),
    ),
  });
}

export async function readBoundaryProposals(
  input: {
    tenant_id: string;
    workflow_id: string;
    environment: "dev" | "prod";
    viewer: ResolvedPrincipal;
  },
  db: Executor,
): Promise<(BoundaryProposalRead & { definition: WorkflowDef }) | null> {
  const reviewed = await reviewedDefinition(input.tenant_id, input.workflow_id, db);
  if (!reviewed) return null;
  const derived = await proposeBoundaries(db, {
    tenant_id: input.tenant_id,
    workflow_id: input.workflow_id,
    definition: reviewed.definition,
    version_id: reviewed.version_id,
    environment: input.environment,
    viewer: input.viewer,
  });
  return {
    ...derived,
    digest: proposalsDigest(derived, input.environment),
    base_version_id: reviewed.version_id,
    draft_version_id: reviewed.draft_version_id,
    definition: reviewed.definition,
  };
}

type ApplyBoundaryProposalsResult =
  | { draft: NonNullable<SaveWorkflowDraftResult["draft"]>; applied_step_ids: string[] }
  | { draft?: never; code: "nothing_to_apply" | "proposals_changed" }
  | SaveWorkflowDraftResult;

export async function applyBoundaryProposals(
  input: {
    tenant_id: string;
    workflow_id: string;
    base_version_id: string | null;
    proposals_digest: string;
    step_ids?: string[];
    environment: "dev" | "prod";
    viewer: ResolvedPrincipal;
    actor_id: string | null;
    actor_type?: "user" | "system_account" | "system";
    request_source: RequestSource;
  },
  db: Executor,
): Promise<ApplyBoundaryProposalsResult> {
  const derived = await readBoundaryProposals(input, db);
  if (!derived) return { code: "not_found", errors: ["workflow not found"] };
  const { definition } = derived;
  if (
    derived.base_version_id !== input.base_version_id ||
    derived.digest !== input.proposals_digest
  )
    return { code: "proposals_changed" };
  const wanted = input.step_ids ? new Set(input.step_ids) : null;
  const chosen = derived.proposals.filter((entry) => !wanted || wanted.has(entry.step_id));
  if (chosen.length === 0) return { code: "nothing_to_apply" };
  const byStep = new Map(chosen.map((entry) => [entry.step_id, entry]));
  const applied: string[] = [];
  const steps = definition.steps.map((step) => {
    const proposal = byStep.get(step.id);
    if (!proposal || step.kind !== "request") return step;
    applied.push(step.id);
    return applyStepProposal(step, proposal);
  });
  const result = await saveWorkflowDraft(
    {
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      expected_draft_version_id: derived.draft_version_id,
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
