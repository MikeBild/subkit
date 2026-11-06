import type { Executor } from "../db/client.ts";
import type { WorkflowEffectManifest } from "./effect-manifest.ts";
import { previewWorkflowAuthority } from "./execution-authorities.ts";
import { resolveWorkflowReviewEnvironment } from "./execution-environment.ts";
import { diagnoseWorkflow } from "./gate-diagnosis.ts";
import { repairGuidanceForIssues } from "./issue-remedies.ts";
import { inspectHeldPreviewEvidence } from "./report-delivery-proposal.ts";

export interface EnvironmentReview {
  workflow_version_id: string | null | undefined;
  is_draft?: boolean;
  eligible_for_repeated_runs?: boolean;
  issues?: WorkflowEffectManifest["issues"];
  unavailable_steps?: string[];
  verification_unavailable?: boolean;
  repair_guidance?: ReturnType<typeof repairGuidanceForIssues>;
  preview_evidence?: Awaited<ReturnType<typeof inspectHeldPreviewEvidence>>;
}

export async function reviewAutomationEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  version_id: string | null | undefined,
  environment: "dev" | "prod",
  { is_draft }: { is_draft: boolean },
): Promise<EnvironmentReview> {
  try {
    const input = version_id
      ? {
          tenant_id,
          workflow_id,
          workflow_version_id: version_id,
          execution_environment: environment,
        }
      : null;
    const preview = input ? await previewWorkflowAuthority(input, db) : null;
    const held = input ? await inspectHeldPreviewEvidence(input, db) : null;
    const diagnosis =
      version_id && preview
        ? await diagnoseWorkflow(db, tenant_id, workflow_id, environment, {
            version_id,
            preview,
            held,
          })
        : null;
    return {
      workflow_version_id: version_id,
      is_draft,
      eligible_for_repeated_runs: preview?.eligible_for_repeated_runs ?? false,
      issues: preview?.manifest.issues ?? [],
      unavailable_steps: preview?.unavailable_steps ?? [],
      preview_evidence: held,
      repair_guidance: repairGuidanceForIssues(
        preview?.manifest.issues ?? [],
        preview?.manifest.effects ?? [],
        preview?.storage_refusals ?? [],
        preview?.request_refusals ?? [],
        diagnosis,
      ),
    };
  } catch {
    return { workflow_version_id: version_id, verification_unavailable: true };
  }
}

type AutomationReadinessState = "eligible" | "repair_required" | "verification_unavailable";

export interface AutomationReadiness {
  environment: "dev" | "prod";
  workflow_version_id: string | null;
  state: AutomationReadinessState;
  issues: Array<{ step_id: string; code: string }>;
  repair_guidance: Array<{ step_id: string; code: string; instruction: string }>;
}

export async function inspectAutomationReadiness(
  db: Executor,
  tenant_id: string,
  workflow: { id: string; current_version_id?: string | null; draft_version_id?: string | null },
  environment?: "dev" | "prod",
): Promise<AutomationReadiness> {
  const version_id = workflow.draft_version_id ?? workflow.current_version_id ?? null;
  const resolved =
    environment ??
    (
      await resolveWorkflowReviewEnvironment(db, tenant_id, workflow.id, { version_id }).catch(
        () => ({ environment: "prod" as const }),
      )
    ).environment;
  const review = await reviewAutomationEnvironment(
    db,
    tenant_id,
    workflow.id,
    version_id,
    resolved,
    { is_draft: Boolean(workflow.draft_version_id) },
  );
  const state: AutomationReadinessState = review.verification_unavailable
    ? "verification_unavailable"
    : review.eligible_for_repeated_runs
      ? "eligible"
      : "repair_required";
  return {
    environment: resolved,
    workflow_version_id: version_id,
    state,
    issues: (review.issues ?? []).map(({ step_id, code }) => ({ step_id, code })),
    repair_guidance: (review.repair_guidance ?? []).map(({ step_id, code, instruction }) => ({
      step_id,
      code,
      instruction,
    })),
  };
}
