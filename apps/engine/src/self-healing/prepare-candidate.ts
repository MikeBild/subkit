import { and, eq, sql } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { patchCandidates, workflowVersions } from "../db/schema/index.ts";
import { PatchProposalSchema } from "../llm/flows/repair.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { PatchDecisionError } from "./candidate-decision.ts";
import { readPatchReadiness } from "./candidate-readiness.ts";
import { applyPatchToWorkflowDag } from "./patch-apply.ts";
import { resolveCandidateStepKey } from "./step-snapshot.ts";

/** Persist an immutable review target. Neither activation nor execution is performed. */
export async function preparePatchCandidate(
  params: {
    tenant_id: string;
    candidate_id: string;
    actor_id: string | null;
    expected_review_digest: string;
  },
  db: Db,
) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
        ),
      )
      .limit(1);
    if (!candidate) throw new PatchDecisionError("candidate_missing");
    const workflow = await lockWorkflowForVersionWrite(tx, params.tenant_id, candidate.workflow_id);
    const readiness = await readPatchReadiness(params.tenant_id, candidate, tx);
    if (!readiness.reviewable || readiness.review_digest !== params.expected_review_digest)
      throw new PatchDecisionError(readiness.review_reason ?? "review_changed");
    const note = `repair-preparation:${candidate.id}:${readiness.review_digest}`;
    const [existing] = await tx
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, params.tenant_id),
          eq(workflowVersions.workflow_id, candidate.workflow_id),
          eq(workflowVersions.note, note),
        ),
      )
      .limit(1);
    if (existing)
      return { workflow_version_id: existing.id, review_digest: params.expected_review_digest };
    const [base] = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, params.tenant_id),
          eq(
            workflowVersions.id,
            workflow?.current_version_id ?? "00000000-0000-0000-0000-000000000000",
          ),
        ),
      )
      .limit(1);
    const diff = candidate.diff as Record<string, unknown>;
    const proposal = PatchProposalSchema.parse(diff.proposal);
    const patch = applyPatchToWorkflowDag(
      base?.dag,
      await resolveCandidateStepKey(params.tenant_id, diff, tx),
      proposal,
    );
    if (!patch.ok) throw new PatchDecisionError(patch.reason);
    const [version] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id: params.tenant_id,
        workflow_id: candidate.workflow_id,
        dag: patch.dag,
        note,
        version: sql<number>`(SELECT COALESCE(MAX(${workflowVersions.version}), 0) + 1 FROM ${workflowVersions} WHERE ${workflowVersions.tenant_id} = ${params.tenant_id} AND ${workflowVersions.workflow_id} = ${candidate.workflow_id})`,
      })
      .returning({ id: workflowVersions.id });
    if (!version) throw new Error("repair preparation insert failed");
    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: "user",
        actor_id: params.actor_id,
        action: AuditAction.PATCH_CANDIDATE_PREPARED,
        resource_type: "patch_candidate",
        resource_id: candidate.id,
        result: "success",
        metadata: { workflow_version_id: version.id, base_version_id: readiness.base_version_id },
      },
      tx,
    );
    return { workflow_version_id: version.id, review_digest: params.expected_review_digest };
  });
}
