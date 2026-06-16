// Auto-apply a self-healing patch.
//
// Extracted from `service.ts` to keep that file under the 1000-LOC
// ceiling enforced by the audit-invariants `file_size` gate. This holds
// only the apply primitive — writing the new workflow version + flipping
// the candidate to `applied`. It has no dependency on `service.ts`, so
// both the reactive/proactive apply paths and the manual approve route
// can import it without an import cycle.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { patchCandidates, workflows, workflowVersions } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Auto-apply a safe patch by writing a new workflow version whose `dag`
 * carries an appended `__self_healing` annotation. The engine does NOT
 * try to surgically rewrite the upstream DAG — the repair flow's
 * narrow palette is applied out-of-band on the NEXT execution by the
 * request driver, which reads the patch_candidates row and layers the
 * rename on top of the live step. The workflow_versions insert is the
 * audit anchor that makes the change reviewable and reversible.
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
): Promise<string | null> {
  const wfRows = await tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, params.tenant_id), eq(workflows.id, params.workflow_id)))
    .limit(1);
  const wf = wfRows[0];
  if (!wf?.current_version_id) return null;

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
  if (!currentVersion) return null;

  const newDag = {
    ...(currentVersion.dag as Record<string, unknown>),
    __self_healing: {
      applied_patch_id: params.candidate_id,
      kind: params.proposal.kind,
      description: params.proposal.description,
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
  if (!inserted) return null;

  await tx
    .update(workflows)
    .set({ current_version_id: inserted.id, updated_at: new Date() })
    .where(eq(workflows.id, params.workflow_id));

  await tx
    .update(patchCandidates)
    .set({ status: "applied", updated_at: new Date() })
    .where(eq(patchCandidates.id, params.candidate_id));

  return inserted.id;
}
