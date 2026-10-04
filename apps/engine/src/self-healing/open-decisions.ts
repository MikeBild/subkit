import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import { errorFields, log } from "../logging/logger.ts";
import { recordPatchCandidate } from "../observability/instrumentation.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import {
  type PatchReadiness,
  readPatchReadiness,
  readPatchReadinessBatch,
} from "./candidate-readiness.ts";

type CandidateRow = typeof patchCandidates.$inferSelect;

export const UNDECIDABLE_REASONS: ReadonlySet<string> = new Set([
  "no_change",
  "patch_not_applicable",
  "workflow_missing",
  "no_step_anchor",
]);

export interface OpenPatchDecision {
  row: CandidateRow;
  readiness: PatchReadiness;
}

export interface OpenPatchDecisions {
  open_total: number;
  oldest_open_at: Date | null;
  items: OpenPatchDecision[];
  unreviewable_total: number;
  unreviewable_by_reason: Record<string, number>;
}

export async function readOpenPatchDecisions(
  db: Executor,
  tenant_id: string,
  opts: { limit?: number; workflow_id?: string } = {},
): Promise<OpenPatchDecisions> {
  const tenantConds = [
    eq(patchCandidates.tenant_id, tenant_id),
    eq(patchCandidates.status, "proposed"),
  ];
  if (opts.workflow_id) tenantConds.push(eq(patchCandidates.workflow_id, opts.workflow_id));
  const rows = await db
    .select()
    .from(patchCandidates)
    .where(and(...tenantConds))
    .orderBy(asc(patchCandidates.created_at), asc(patchCandidates.id));
  const readiness = await readPatchReadinessBatch(tenant_id, rows, db);
  const open: OpenPatchDecision[] = [];
  const unreviewable_by_reason: Record<string, number> = {};
  rows.forEach((row, index) => {
    const r = readiness[index];
    if (!r) return;
    if (r.reviewable) open.push({ row, readiness: r });
    else {
      const reason = r.review_reason ?? "unknown";
      unreviewable_by_reason[reason] = (unreviewable_by_reason[reason] ?? 0) + 1;
    }
  });
  return {
    open_total: open.length,
    oldest_open_at: open[0]?.row.created_at ?? null,
    items: opts.limit === undefined ? open : open.slice(0, opts.limit),
    unreviewable_total: rows.length - open.length,
    unreviewable_by_reason,
  };
}

export async function closeUndecidableCandidate(
  tx: Executor,
  row: CandidateRow,
  readiness: PatchReadiness,
  via: string,
): Promise<boolean> {
  const reason = readiness.review_reason;
  if (!reason || !UNDECIDABLE_REASONS.has(reason)) return false;
  const closedAt = new Date();
  const closed = await tx
    .update(patchCandidates)
    .set({
      status: "inapplicable",
      closed_reason: reason,
      closed_against_version_id: readiness.base_version_id,
      closed_at: closedAt,
      updated_at: closedAt,
    })
    .where(
      and(
        eq(patchCandidates.tenant_id, row.tenant_id),
        eq(patchCandidates.id, row.id),
        eq(patchCandidates.status, "proposed"),
      ),
    )
    .returning({ id: patchCandidates.id });
  if (closed.length === 0) return false;
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.PATCH_CANDIDATE_CLOSED_INAPPLICABLE,
      resource_type: "patch_candidate",
      resource_id: row.id,
      result: "success",
      reason,
      metadata: {
        workflow_id: row.workflow_id,
        closed_reason: reason,
        closed_against_version_id: readiness.base_version_id,
        via,
      },
    },
    tx,
  );
  recordPatchCandidate({ classification: row.classification, decision: "closed_inapplicable" });
  log.selfHealing.patch.closedInapplicable({
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    candidate_id: row.id,
    reason,
    closed_against_version_id: readiness.base_version_id,
    via,
  });
  return true;
}

export async function closeIfUndecidable(
  tx: Executor,
  row: CandidateRow,
  via: string,
): Promise<boolean> {
  if (row.status !== "proposed") return false;
  return closeUndecidableCandidate(tx, row, await readPatchReadiness(row.tenant_id, row, tx), via);
}

export async function sweepUndecidableCandidates(db: Db, tenant_id: string): Promise<number> {
  const pending = await db
    .select({ workflow_id: patchCandidates.workflow_id })
    .from(patchCandidates)
    .where(and(eq(patchCandidates.tenant_id, tenant_id), eq(patchCandidates.status, "proposed")));
  const workflowIds = [...new Set(pending.map((row) => row.workflow_id))].sort();
  let closed = 0;
  for (const workflow_id of workflowIds) {
    try {
      closed += await db.transaction(async (tx) => {
        await lockWorkflowForVersionWrite(tx, tenant_id, workflow_id);
        const rows = await tx
          .select()
          .from(patchCandidates)
          .where(
            and(
              eq(patchCandidates.tenant_id, tenant_id),
              eq(patchCandidates.workflow_id, workflow_id),
              eq(patchCandidates.status, "proposed"),
            ),
          )
          .orderBy(asc(patchCandidates.id));
        const readiness = await readPatchReadinessBatch(tenant_id, rows, tx);
        let n = 0;
        for (const [index, row] of rows.entries()) {
          const r = readiness[index];
          if (!r) continue;
          try {
            if (await tx.transaction((sp) => closeUndecidableCandidate(sp, row, r, "sweep")))
              n += 1;
          } catch (err) {
            log.selfHealing.patch.sweepFailed({
              tenant_id,
              workflow_id,
              candidate_id: row.id,
              ...errorFields(err),
            });
          }
        }
        return n;
      });
    } catch (err) {
      log.selfHealing.patch.sweepFailed({ tenant_id, workflow_id, ...errorFields(err) });
    }
  }
  if (closed > 0) invalidateTenantState(tenant_id);
  return closed;
}
