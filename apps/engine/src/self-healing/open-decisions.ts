// What is waiting for a human, asked once.
//
// A patch candidate is an OPEN decision when it is `proposed` AND the current
// workflow version lets a person actually decide it (readiness `reviewable`).
// Every surface that says "N fixes awaiting review" — the health digest and its
// headline, the MCP connect instructions, the operational overview, the
// patch-candidates list's `reviewable_total`, the conversation tools — reads
// that number from `readOpenPatchDecisions`. Three predicates used to answer the
// question (every `proposed` row, a list capped at 50, and the readiness
// filter), so one installation said 48, 50 and 0 about the same queue.
//
// A `proposed` row that readiness proves undecidable is not open, and it is not
// a decision either: no human answer could make it land. `closeUndecidable
// Candidate` moves it to `inapplicable` with the reason and the version it was
// proven against. It is never used to push a count down — only a readiness
// reason in UNDECIDABLE_REASONS closes a row; anything else (a step that moved,
// a malformed DAG) stays proposed and is reported under `unreviewable_by_reason`.

import { and, asc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { patchCandidates } from "../db/schema/index.ts";
import { errorFields, log } from "../logging/logger.ts";
import { recordPatchCandidate } from "../observability/instrumentation.ts";
import { lockWorkflowForVersionWrite } from "../workflows/version-write-lock.ts";
import {
  type PatchReadiness,
  readPatchReadiness,
  readPatchReadinessBatch,
} from "./candidate-readiness.ts";

type CandidateRow = typeof patchCandidates.$inferSelect;

/**
 * Readiness reasons that prove the current workflow version can never take the
 * patch: it changes nothing, its kind has no executable semantics, the
 * workflow is gone, or the candidate names no step to rewrite. A new version
 * re-opens evaluation (see terminal-dedup).
 *
 * `no_step_anchor` is a defect of the CANDIDATE, not of the version: no answer
 * a person gives can make an anchorless patch land, on this version or any
 * other. Leaving such a row `proposed` kept it out of every count and in the
 * queue forever — and, worse, let it stand in for the same drift in the active
 * lookup, so a correctly anchored re-proposal was deduplicated against it.
 * Its closure suppresses only an equally anchorless re-proposal on the same
 * version (`matchesInapplicableBoundary`), so it can never mute a drift that
 * a person could decide.
 */
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
  /** Exact count of open decisions — never the length of a capped list. */
  open_total: number;
  oldest_open_at: Date | null;
  /** Oldest first; capped at `limit` when one is given. */
  items: OpenPatchDecision[];
  /** `proposed` rows a human cannot decide on the current version. */
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

/**
 * Move a `proposed` candidate to `inapplicable` when — and only when — its
 * readiness proves it undecidable. Compare-and-set on `status = 'proposed'`,
 * so it can never overwrite a concurrent approve or reject. Returns whether the
 * row was closed.
 */
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
      // The workflow's CURRENT version — the one readiness was proven against,
      // not the version the proposal was drafted on.
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

/** Read readiness for one candidate and close it if that proves it undecidable. */
export async function closeIfUndecidable(
  tx: Executor,
  row: CandidateRow,
  via: string,
): Promise<boolean> {
  if (row.status !== "proposed") return false;
  return closeUndecidableCandidate(tx, row, await readPatchReadiness(row.tenant_id, row, tx), via);
}

/**
 * The per-tenant sweep the proactive scan runs on every tick. It closes the
 * rows whose endpoint no longer emits a signal (so the refresh path never
 * visits them) and replaces the old daily `updated_at` bump, which kept an
 * undecidable row looking freshly active forever.
 *
 * One transaction per workflow, holding the workflow's version-write lock
 * BEFORE readiness is read — the same order (workflow, then candidate) as
 * approve and processDriftSignal. Without it an operator could save a version
 * the patch applies to between the read and the close, and the row would be
 * closed against a version that is no longer current. Each close runs in its
 * own savepoint and each workflow in its own transaction, so one bad row or
 * workflow is logged and skipped instead of blocking the rest.
 */
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
  return closed;
}
