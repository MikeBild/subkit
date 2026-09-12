// Manual approve / reject of a proposed patch candidate.
//
// Split out of `service.ts` (which holds the signal→candidate pipeline and
// the reactive/proactive loops) to keep that file under the 1000-LOC
// invariant. These two are the operator-facing decision endpoints — invoked
// from the HTTP route, the MCP `approve_patch_candidate` tool, and the
// outcome tracker — and share no private state with the pipeline, only the
// same external helpers (`autoApplyPatch`, audit, metrics).

import { and, eq } from "drizzle-orm";
import { audit, auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { patchCandidates } from "../db/schema/index.ts";
import type { PatchProposal } from "../llm/flows/repair.ts";
import { log } from "../logging/logger.ts";
import { recordPatchCandidate } from "../observability/instrumentation.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import { autoApplyPatch, logPatchNotApplied } from "./auto-apply.ts";
import { readPatchReadiness } from "./candidate-readiness.ts";

export class PatchDecisionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function approvePatchCandidate(
  params: {
    tenant_id: string;
    candidate_id: string;
    actor_id: string | null;
    expected_review_digest?: string;
    prepared_version_id?: string;
  },
  exec?: Db,
): Promise<string | null> {
  const db = exec ?? getDb();
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
        ),
      )
      .limit(1);
    const found = rows[0];
    if (!found) return null;
    await lockWorkflowForVersionWrite(tx, params.tenant_id, found.workflow_id);
    const [row] = await tx
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
        ),
      )
      .for("update")
      .limit(1);
    if (row?.status !== "proposed") return null;
    const readiness = await readPatchReadiness(params.tenant_id, row, tx);
    if (
      params.expected_review_digest &&
      readiness.review_digest !== params.expected_review_digest
    ) {
      await auditAwait(
        {
          tenant_id: params.tenant_id,
          actor_type: params.actor_id ? "user" : "system",
          actor_id: params.actor_id,
          action: AuditAction.PATCH_CANDIDATE_APPROVED,
          resource_type: "patch_candidate",
          resource_id: row.id,
          result: "error",
          reason: readiness.review_reason ?? "review_changed",
        },
        tx,
      );
      return { failure: readiness.review_reason ?? "review_changed" };
    }

    const diff = (row.diff ?? {}) as Record<string, unknown>;
    const proposalRaw = diff.proposal as PatchProposal | undefined;
    if (!proposalRaw) return null;

    const outcome = await autoApplyPatch(tx, {
      tenant_id: params.tenant_id,
      workflow_id: row.workflow_id,
      candidate_id: row.id,
      proposal: proposalRaw,
      ...(params.prepared_version_id ? { prepared_version_id: params.prepared_version_id } : {}),
    });

    // An approval the engine cannot perform is an approval that changed
    // nothing. Say so — audit it as an error with the reason, leave the
    // candidate `proposed`, then throw after committing the refusal audit.
    // The route returns a conflict instead of inventing a version.
    if (!outcome.applied) {
      await auditAwait(
        {
          tenant_id: params.tenant_id,
          actor_type: params.actor_id ? "user" : "system",
          actor_id: params.actor_id,
          action: AuditAction.PATCH_CANDIDATE_APPROVED,
          resource_type: "patch_candidate",
          resource_id: row.id,
          result: "error",
          reason: outcome.reason,
          metadata: { workflow_id: row.workflow_id, new_workflow_version_id: null },
        },
        tx,
      );
      logPatchNotApplied(
        { tenant_id: params.tenant_id, workflow_id: row.workflow_id, source: "manual_approve" },
        row.id,
        outcome.reason,
        "manual_approve",
      );
      return { failure: outcome.reason };
    }

    await auditAwait(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.PATCH_CANDIDATE_APPROVED,
        resource_type: "patch_candidate",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: row.workflow_id,
          new_workflow_version_id: outcome.version_id,
          changed_paths: outcome.changed_paths,
        },
      },
      tx,
    );
    await writeEvent(tx, {
      tenant_id: params.tenant_id,
      channel: "notification.emitted",
      type: "patch.applied",
      payload: {
        patch_candidate_id: row.id,
        workflow_id: row.workflow_id,
        workflow_version_id: outcome.version_id,
        changed_paths: outcome.changed_paths,
        auto_applied: false,
      },
    });
    recordPatchCandidate({ classification: "manual", decision: "approved" });
    log.selfHealing.patch.applied({
      candidate_id: row.id,
      workflow_id: row.workflow_id,
      new_workflow_version_id: outcome.version_id,
      changed_paths: outcome.changed_paths,
      actor_id: params.actor_id,
      decision: "manual_approve",
    });
    return outcome.version_id;
  });
  if (result && typeof result === "object") throw new PatchDecisionError(result.failure);
  return result;
}

export async function rejectPatchCandidate(
  params: {
    tenant_id: string;
    candidate_id: string;
    actor_id: string | null;
    reason?: string;
  },
  exec?: Db,
): Promise<boolean> {
  const db = exec ?? getDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(patchCandidates)
      .set({ status: "rejected", updated_at: new Date() })
      .where(
        and(
          eq(patchCandidates.tenant_id, params.tenant_id),
          eq(patchCandidates.id, params.candidate_id),
          eq(patchCandidates.status, "proposed"),
        ),
      )
      .returning();
    if (rows.length === 0) return false;
    audit(
      {
        tenant_id: params.tenant_id,
        actor_type: params.actor_id ? "user" : "system",
        actor_id: params.actor_id,
        action: AuditAction.PATCH_CANDIDATE_REJECTED,
        resource_type: "patch_candidate",
        resource_id: params.candidate_id,
        result: "success",
        ...(params.reason ? { reason: params.reason } : {}),
      },
      tx,
    );
    recordPatchCandidate({ classification: "manual", decision: "rejected" });
    log.selfHealing.patch.rejected({
      candidate_id: params.candidate_id,
      actor_id: params.actor_id,
      reason: params.reason ?? null,
    });
    return true;
  });
}
