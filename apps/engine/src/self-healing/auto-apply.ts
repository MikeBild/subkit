import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { patchCandidates, workflows, workflowVersions } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import { carryApprovalsForward } from "../workflows/authority-inheritance.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import {
  applyPatchToWorkflowDag,
  candidateDriftKind,
  type PatchApplyFailure,
} from "./patch-apply.ts";
import { resolveCandidateStepKey } from "./step-snapshot.ts";

export type AutoApplyResult =
  | { applied: true; version_id: string; changed_paths: string[] }
  | { applied: false; reason: PatchApplyFailure | "workflow_missing" | "version_missing" };

export function logPatchNotApplied(
  ctx: { tenant_id: string; workflow_id: string; source: string },
  candidate_id: string,
  reason: string,
  detail: string,
): void {
  log.selfHealing.patch.notApplicable({ ...ctx, candidate_id, reason, detail });
}

export async function autoApplyPatch(
  tx: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    candidate_id: string;
    proposal: PatchProposal;
    prepared_version_id?: string;
  },
): Promise<AutoApplyResult> {
  const wf = await lockWorkflowForVersionWrite(tx, params.tenant_id, params.workflow_id);
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

  const { stepKey, driftKind } = await resolvePatchStepKey(
    tx,
    params.tenant_id,
    params.candidate_id,
  );
  const patched = applyPatchToWorkflowDag(currentVersion.dag, stepKey, params.proposal, driftKind);
  if (!patched.ok) return { applied: false, reason: patched.reason };

  const newDag = {
    ...patched.dag,
    __self_healing: {
      applied_patch_id: params.candidate_id,
      kind: params.proposal.kind,
      description: params.proposal.description,
      step_id: stepKey,
      changed_paths: patched.changed_paths,
      applied_at: new Date().toISOString(),
    },
  };

  const [prepared] = params.prepared_version_id
    ? await tx
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, params.tenant_id),
            eq(workflowVersions.workflow_id, params.workflow_id),
            eq(workflowVersions.id, params.prepared_version_id),
          ),
        )
        .limit(1)
    : [];
  if (
    params.prepared_version_id &&
    (!prepared || workflowJsonDigest(prepared.dag) !== workflowJsonDigest(patched.dag))
  )
    return { applied: false, reason: "patch_not_applicable" };
  const [inserted] = prepared
    ? [prepared]
    : await tx
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
    .where(and(eq(workflows.tenant_id, params.tenant_id), eq(workflows.id, params.workflow_id)));
  await carryApprovalsForward(tx, {
    tenant_id: params.tenant_id,
    workflow_id: params.workflow_id,
    from_version_id: wf.current_version_id,
    to_version_id: inserted.id,
    actor_id: null,
  });

  await tx
    .update(patchCandidates)
    .set({
      status: "applied",
      diff: sql`${patchCandidates.diff} || jsonb_build_object('applied_version_id', ${inserted.id}::text)`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(patchCandidates.tenant_id, params.tenant_id),
        eq(patchCandidates.id, params.candidate_id),
      ),
    );

  return { applied: true, version_id: inserted.id, changed_paths: patched.changed_paths };
}

async function resolvePatchStepKey(
  tx: Executor,
  tenant_id: string,
  candidate_id: string,
): Promise<{ stepKey: string | null; driftKind: string | null }> {
  const rows = await tx
    .select({ diff: patchCandidates.diff })
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenant_id), eq(patchCandidates.id, candidate_id)))
    .limit(1);
  const raw = rows[0]?.diff;
  const diff =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  return {
    stepKey: await resolveCandidateStepKey(tenant_id, diff, tx),
    driftKind: candidateDriftKind(diff),
  };
}
