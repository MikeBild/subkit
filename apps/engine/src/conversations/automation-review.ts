import type { Db } from "../db/client.ts";
import { inspectScheduleAutomation } from "../scheduler/automation-status.ts";
import { listSchedules } from "../scheduler/repo.ts";
import type { WorkflowEffectManifest } from "../workflows/effect-manifest.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { repairGuidanceForIssues } from "../workflows/issue-remedies.ts";
import { inspectHeldPreviewEvidence } from "../workflows/report-delivery-proposal.ts";
import { getWorkflow } from "../workflows/service.ts";

/** Keep live scheduling evidence separate from the saved version the person reviews. */
export async function inspectAutomationReview(db: Db, tenant_id: string, workflow_id: string) {
  const workflow = await getWorkflow(tenant_id, workflow_id, db);
  if (!workflow) return null;
  const version_id = workflow.draft_version_id ?? workflow.current_version_id;
  const { rows } = await listSchedules(db, tenant_id, workflow_id);
  return {
    workflow_id,
    schedules: await Promise.all(
      rows.map(async (row) => {
        const active = await inspectScheduleAutomation(row, db);
        let review: {
          workflow_version_id: string | null | undefined;
          is_draft?: boolean;
          eligible_for_repeated_runs?: boolean;
          issues?: WorkflowEffectManifest["issues"];
          unavailable_steps?: string[];
          verification_unavailable?: boolean;
          repair_guidance?: ReturnType<typeof repairGuidanceForIssues>;
          preview_evidence?: Awaited<ReturnType<typeof inspectHeldPreviewEvidence>>;
        };
        try {
          const preview = version_id
            ? await previewWorkflowAuthority(
                {
                  tenant_id,
                  workflow_id,
                  workflow_version_id: version_id,
                  execution_environment: row.execution_mode,
                },
                db,
              )
            : null;
          review = {
            workflow_version_id: version_id,
            is_draft: Boolean(workflow.draft_version_id),
            eligible_for_repeated_runs: preview?.eligible_for_repeated_runs ?? false,
            issues: preview?.manifest.issues ?? [],
            unavailable_steps: preview?.unavailable_steps ?? [],
            preview_evidence: version_id
              ? await inspectHeldPreviewEvidence(
                  {
                    tenant_id,
                    workflow_id,
                    workflow_version_id: version_id,
                    execution_environment: row.execution_mode,
                  },
                  db,
                )
              : null,
            // The remedy travels with the diagnosis. Joining over `issues` (not
            // over `effects`) is what makes a storage or child-call problem
            // carry its fix too — the old construction only ever matched one
            // hard-coded report endpoint, so every other issue arrived bare.
            repair_guidance: repairGuidanceForIssues(
              preview?.manifest.issues ?? [],
              preview?.manifest.effects ?? [],
            ),
          };
        } catch {
          review = { workflow_version_id: version_id, verification_unavailable: true };
        }
        return { environment: row.execution_mode, ...active, review };
      }),
    ),
  };
}
