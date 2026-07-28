// Apply a self-healing patch to the workflow definition.
//
// Extracted from `service.ts` to keep that file under the 1000-LOC
// ceiling enforced by the audit-invariants `file_size` gate. This holds
// only the apply primitive — rewriting the patched step into a new workflow
// version + flipping the candidate to `applied`. It has no dependency on
// `service.ts`, so both the reactive/proactive apply paths and the manual
// approve route can import it without an import cycle.

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates, workflows, workflowVersions } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import { applyPatchToWorkflowDag, type PatchApplyFailure } from "./patch-apply.ts";
import { loadWorkflowStepKey } from "./step-snapshot.ts";

export type AutoApplyResult =
  | { applied: true; version_id: string; changed_paths: string[] }
  | { applied: false; reason: PatchApplyFailure | "workflow_missing" | "version_missing" };

/**
 * Report a patch that was cleared for apply but could not be performed on the
 * definition. The candidate stays `proposed`: an unapplied patch must never be
 * recorded as a repair, or the next scan reads a healed endpoint that was
 * never healed.
 */
export function logPatchNotApplied(
  ctx: { tenant_id: string; workflow_id: string; source: string },
  candidate_id: string,
  reason: string,
  detail: string,
): void {
  log.selfHealing.patch.notApplicable({ ...ctx, candidate_id, reason, detail });
}

/**
 * Apply a patch by writing a new workflow version in which the patched step is
 * actually rewritten, then point the workflow at it and mark the candidate
 * `applied`.
 *
 * The rewrite runs through `applyPatchToWorkflowDag` — the same pure function
 * behind the operator preview — so the version that goes live is the diff the
 * operator approved, not a re-derivation of it.
 *
 * The candidate is marked `applied` ONLY when a step actually changed. When the
 * patch cannot be performed (no failing-step anchor, the step is gone, the
 * proposal kind has no executable semantics), this writes nothing and returns
 * the reason: a version that changes no behaviour must never be recorded as a
 * repair, or the next drift scan sees a healed endpoint that was never healed.
 *
 * Note: this does NOT touch `workflows_schedules` — applying a patch
 * rotates the version in place (updates `current_version_id`) without
 * deleting schedule bindings, so an auto-applied safe patch never
 * unbinds a scheduled workflow.
 */
export async function autoApplyPatch(
  tx: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    candidate_id: string;
    proposal: PatchProposal;
  },
): Promise<AutoApplyResult> {
  const wfRows = await tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, params.tenant_id), eq(workflows.id, params.workflow_id)))
    .limit(1);
  const wf = wfRows[0];
  if (!wf?.current_version_id) return { applied: false, reason: "workflow_missing" };

  const cvRows = await tx
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, params.tenant_id),
        eq(workflowVersions.id, wf.current_version_id),
      ),
    )
    .limit(1);
  const currentVersion = cvRows[0];
  if (!currentVersion) return { applied: false, reason: "version_missing" };

  const stepKey = await resolvePatchStepKey(tx, params.tenant_id, params.candidate_id);
  const patched = applyPatchToWorkflowDag(currentVersion.dag, stepKey, params.proposal);
  if (!patched.ok) return { applied: false, reason: patched.reason };

  const newDag = {
    ...patched.dag,
    // Provenance, not mechanism: the rewrite above is what changes behaviour.
    // This records which candidate produced it so an operator reading a version
    // can trace it back without joining through the audit log.
    __self_healing: {
      applied_patch_id: params.candidate_id,
      kind: params.proposal.kind,
      description: params.proposal.description,
      step_id: stepKey,
      changed_paths: patched.changed_paths,
      applied_at: new Date().toISOString(),
    },
  };

  // DB-side MAX(version)+1 in the INSERT itself — a read-then-insert
  // computed in JS loses the race when two reactive repairs for the same
  // workflow run concurrently (both read the same max, both insert the
  // same version → unique violation rolls one repair back).
  const [inserted] = await tx
    .insert(workflowVersions)
    .values({
      tenant_id: params.tenant_id,
      workflow_id: params.workflow_id,
      version: sql<number>`(SELECT COALESCE(MAX(${workflowVersions.version}), 0) + 1
         FROM ${workflowVersions}
        WHERE ${workflowVersions.tenant_id} = ${params.tenant_id}
          AND ${workflowVersions.workflow_id} = ${params.workflow_id})`,
      dag: newDag,
      note: `self-healing auto-apply of patch ${params.candidate_id}`,
    })
    .returning();
  if (!inserted) return { applied: false, reason: "version_missing" };

  await tx
    .update(workflows)
    .set({ current_version_id: inserted.id, updated_at: new Date() })
    .where(eq(workflows.id, params.workflow_id));

  await tx
    .update(patchCandidates)
    .set({ status: "applied", updated_at: new Date() })
    .where(eq(patchCandidates.id, params.candidate_id));

  return { applied: true, version_id: inserted.id, changed_paths: patched.changed_paths };
}

/**
 * Resolve the DAG step this candidate is about to patch.
 *
 * Two anchors, in order of directness:
 *   1. `diff.workflow_step_id` — the definition step, recorded at proposal
 *      time. Proactive signals have this and nothing else.
 *   2. `diff.step_id` — the failing *execution* row; `loadWorkflowStepKey`
 *      takes the hop from there to the definition.
 *
 * Null when neither resolves, which is a hard stop rather than a guess: a
 * patch with no target must not be recorded as applied.
 */
async function resolvePatchStepKey(
  tx: Executor,
  tenant_id: string,
  candidate_id: string,
): Promise<string | null> {
  const rows = await tx
    .select({ diff: patchCandidates.diff })
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenant_id), eq(patchCandidates.id, candidate_id)))
    .limit(1);
  const raw = rows[0]?.diff;
  const diff =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  if (typeof diff.workflow_step_id === "string") return diff.workflow_step_id;
  if (typeof diff.step_id !== "string") return null;
  return loadWorkflowStepKey(tenant_id, diff.step_id, tx);
}
