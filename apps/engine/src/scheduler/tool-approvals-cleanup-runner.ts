import { and, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

const APPROVAL_RETENTION = sql`interval '1 day'`;

export async function runToolApprovalsCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let expired_deleted = 0;
  let consumed_deleted = 0;

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
