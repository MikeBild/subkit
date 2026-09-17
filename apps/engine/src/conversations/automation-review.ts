import type { Db } from "../db/client.ts";
import { inspectScheduleAutomation } from "../scheduler/automation-status.ts";
import { listSchedules } from "../scheduler/repo.ts";
import type { WorkflowEffectManifest } from "../workflows/effect-manifest.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
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
          repair_guidance?: Array<{ step_id: string; instruction: string }>;
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
            repair_guidance:
              preview?.manifest.effects.flatMap((effect) =>
                effect.target === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" &&
                !effect.report_delivery
                  ? [
                      {
                        step_id: effect.step_id,
                        instruction:
                          "A reviewed report boundary is not available yet; this alone does NOT establish malformed MIME. First inspect the exact-version preview: did this email step materialize, or was it skipped because an upstream request was held or failed? Repair the evidenced upstream cause before changing email construction. sk.buildMimeMessage is supported for single-part text/html or text/plain reports; Base64 content-transfer encoding is supported. Do not infer recipients from transform source code: review checks the materialized message. Changing report content IS supported. Keep method POST and endpoint fixed. Set body to an object with only raw, whose VALUE may be a dynamic reference to the encoded message. Inspect the encoding transform: decoded MIME MUST have explicit From and To mailbox addresses, Subject, MIME-Version: 1.0, Content-Type: text/html or text/plain; preserve agreed addresses. Do not replace report content with a constant. Save the repaired draft, open the real review card to prepare its held preview, and recheck eligibility. No message is sent by that preparation.",
                      },
                    ]
                  : [],
              ) ?? [],
          };
        } catch {
          review = { workflow_version_id: version_id, verification_unavailable: true };
        }
        return { environment: row.execution_mode, ...active, review };
      }),
    ),
  };
}
