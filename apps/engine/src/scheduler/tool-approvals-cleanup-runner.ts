// Retention sweep for `tool_approvals`.
//
// The rows hold AES-256-GCM ciphertext of the exact args a confirm gate
// paused on — args that "may carry secrets an operator typed into a form"
// (`tools/approval.ts`). Nothing else in the engine ever deletes them, so
// without this sweep every approval a tenant ever previewed accumulates
// encrypted secret material for the life of the tenant. Retention is the
// only thing that bounds that liability.
//
// Two sweeps, because the two populations die for different reasons and
// their counts answer different operator questions:
//
//   1) expired + unconsumed — the operator previewed a write and never
//      confirmed it. Unclaimable the moment `expires_at` passes, because
//      `consumeApproval`'s CAS carries `expires_at > now()`. This is the
//      sweep the `tool_approvals_expiry_sweep_idx` partial index exists
//      for: `(expires_at) WHERE consumed_at IS NULL` matches the predicate
//      exactly, so the scan never walks the consumed tail.
//
//   2) consumed — the handle was burned. Single-use plus the same
//      `consumed_at IS NULL` CAS predicate means the ciphertext can never
//      be decrypted again; the row survives only as the forensic record
//      behind `confirmation_already_used`.
//
// Retention is anchored on the last instant each row could still be part
// of an honest answer (see `APPROVAL_RETENTION`), not on `created_at`.
//
// TENANT SCOPING: not applicable. This is a global, cross-tenant retention
// sweep — the predicates are time-only and the summary audit row lands
// under SYSTEM_TENANT_ID, exactly like `mcp-oauth-cleanup-runner.ts` and
// `chat-dedup-cleanup-runner.ts`. There is no tenant on whose behalf the
// sweep runs and no tenant-visible state it changes.
//
// ONE CLOCK: every predicate compares against Postgres' `now()`, the same
// clock `expires_at` was written with and the same clock the claim CAS
// reads. The app clock never participates.
//
// Each sweep has its own try/catch: a transient failure of one must not
// abort the other, nor the rest of the reconciler tick.

import { and, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

/** How long a dead approval outlives its usefulness before the ciphertext
 *  goes away. One day past the anchor instant: long enough that
 *  `classifyClaimMiss` can still tell a late confirmation the honest
 *  `confirmation_expired` / `confirmation_already_used` (a sweep at the
 *  anchor itself would degrade both to `unknown_confirmation`), and long
 *  enough for an operator to reconstruct a failed confirmation the next
 *  morning. Past that the row is pure secret-material liability: with a
 *  24-hour `APPROVAL_TTL_MS`, no ciphertext survives ~48h. */
const APPROVAL_RETENTION = sql`interval '1 day'`;

/**
 * Run both `tool_approvals` retention sweeps and emit one summary audit row.
 *
 * The table is bounded by the TTL plus this retention window, so neither
 * DELETE needs batching: sweep 1 rides the partial expiry index and sweep 2
 * walks a tail that can only hold one retention window of consumed rows.
 */
export async function runToolApprovalsCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let expired_deleted = 0;
  let consumed_deleted = 0;

  // ── Sweep 1: expired, never confirmed ──────────────────────────────────────
  // tenant-filter:exempt — cross-tenant retention sweep
  // Predicate mirrors `tool_approvals_expiry_sweep_idx` so the scan stays on
  // the partial index.
  try {
    const deleted = await db
      .delete(toolApprovals)
      .where(
        and(
          isNull(toolApprovals.consumed_at),
          lt(toolApprovals.expires_at, sql`now() - ${APPROVAL_RETENTION}`),
        ),
      )
      .returning({ id: toolApprovals.id });
    expired_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "tool_approvals_cleanup.expired_failed",
      msg: "tool_approvals expired-approval sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // ── Sweep 2: consumed handles past the forensic window ─────────────────────
  // tenant-filter:exempt — cross-tenant retention sweep
  // Anchored on `consumed_at`, the instant the ciphertext stopped being
  // decryptable by any code path, rather than on `expires_at`.
  try {
    const deleted = await db
      .delete(toolApprovals)
      .where(
        and(
          isNotNull(toolApprovals.consumed_at),
          lt(toolApprovals.consumed_at, sql`now() - ${APPROVAL_RETENTION}`),
        ),
      )
      .returning({ id: toolApprovals.id });
    consumed_deleted = deleted.length;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "tool_approvals_cleanup.consumed_failed",
      msg: "tool_approvals consumed-approval sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // ── Summary audit row ──────────────────────────────────────────────────────
  // Counts aggregate across ALL tenants under SYSTEM_TENANT_ID; SIEM authors
  // should not expect per-tenant rows for this action. The deleted rows'
  // approval ids are NOT recorded: each already has its own
  // APPROVAL_REQUESTED (and APPROVAL_APPROVED / APPROVAL_REJECTED) lifecycle
  // in `audit_log`, which this sweep does not touch.
  try {
    await auditAwait(
      {
        tenant_id: SYSTEM_TENANT_ID,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.APPROVAL_EXPIRED_PRUNED,
        resource_type: "tool_approval",
        resource_id: null,
        result: "success",
        metadata: {
          request_source: "scheduler",
          sweep: "tool_approvals",
          expired_deleted,
          consumed_deleted,
        },
      },
      db,
    );
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "tool_approvals_cleanup.audit_failed",
      msg: "tool_approvals cleanup audit row failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // Log every run (even 0/0), symmetric with the other retention sweeps, so an
  // operator scanning structured logs can prove the sweep is alive.
  logger.info({
    module: "scheduler",
    action: "tool_approvals_cleanup.fired",
    msg: "tool_approvals retention sweep completed",
    tick_id: tickId,
    expired_deleted,
    consumed_deleted,
    deleted: expired_deleted + consumed_deleted,
    duration_ms: Date.now() - started.getTime(),
  });
}
