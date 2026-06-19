// One-shot code backfill: rewrite ACTIVE stored workflow definitions
// from `kind:"loop"` to per-step `for_each` on the single body step.
//
// Runs in the migrations boot phase (called from `db/migrate.ts`
// `runMigrations` after the embedded SQL set and the item_var backfill),
// so it completes before any subsystem touches workflows — same guarantee
// the SQL backfills get from the drizzle journal.
//
// Per-workflow contract:
//   - eligibility is checked by `rewriteLoopsToForEach` (structural
//     equivalence proof: single-body loop, no downstream scope-key
//     reference, rewritten definition passes validateWorkflowDef);
//   - ineligible workflows are LEFT UNCHANGED on the legacy loop
//     execution path — the loop driver and loop-scope.ts remain;
//   - the new version is written through
//     `rotateWorkflowVersionInternal` (definition-only rotate — it
//     NEVER reconciles trigger bindings, so `workflows_schedules` rows
//     survive; parity is additionally asserted inside the transaction);
//   - an audit_log entry (kind: "loop_to_for_each_migration") carries
//     the before/after change set per migrated workflow.
//
// Idempotency: one row in `data_migrations` under
// LOOP_TO_FOR_EACH_BACKFILL_NAME; present row → boot no-op.
//
// Failures never break boot: each workflow is in its own try/catch,
// and the caller in migrate.ts wraps the whole backfill too.

import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { logger } from "../../logging/logger.ts";
import { rewriteLoopsToForEach } from "../../workflows/migrate-loop-to-for-each.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { rotateWorkflowVersionInternal } from "../../workflows/version-rotate.ts";
import type { Db, Executor } from "../client.ts";
import {
  dataMigrations,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../schema/index.ts";

export const LOOP_TO_FOR_EACH_BACKFILL_NAME = "loop_to_for_each_v1";

export interface LoopToForEachBackfillReport {
  /** True when the marker row already existed — nothing was scanned. */
  skipped: boolean;
  /** Workflows whose current version contained at least one eligible loop. */
  affected: number;
  migrated: number;
  needs_review: number;
}

async function scheduleRowCount(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<number> {
  const rows = await exec
    .select({ c: sql<number>`count(*)::int` })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    );
  return Number(rows[0]?.c ?? 0);
}

async function flagNeedsReview(
  db: Db,
  args: {
    tenant_id: string;
    workflow_id: string;
    slug: string;
    reason: string;
    loop_step_id?: string | undefined;
  },
): Promise<void> {
  logger.warn({
    module: "workflows",
    action: "workflow.loop_to_for_each_migration.needs_review",
    msg: "loop→for_each migration left workflow untouched — manual review required",
    tenant_id: args.tenant_id,
    workflow_id: args.workflow_id,
    slug: args.slug,
    reason: args.reason,
    ...(args.loop_step_id ? { loop_step_id: args.loop_step_id } : {}),
  });
  await auditAwait(
    {
      tenant_id: args.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.WORKFLOW_UPDATED,
      resource_type: "workflow",
      resource_id: args.workflow_id,
      result: "error",
      metadata: {
        kind: "loop_to_for_each_migration_needs_review",
        reason: args.reason,
        ...(args.loop_step_id ? { loop_step_id: args.loop_step_id } : {}),
      },
    },
    db,
  );
}

/**
 * Walk every live workflow's CURRENT version; definitions that contain
 * eligible `loop` steps are rewritten to `for_each` and committed as a
 * new version. Historical version rows stay immutable.
 *
 * Ineligible loops (multi-body, complex JSONata `over`, downstream scope
 * reference, validation failure) are left on the legacy loop path without
 * logging a needs_review entry — they are expected to stay on the legacy
 * path indefinitely (same as Fix H left 4 of 15 in the estate migration).
 */
export async function runLoopToForEachBackfill(db: Db): Promise<LoopToForEachBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger
    .where(eq(dataMigrations.name, LOOP_TO_FOR_EACH_BACKFILL_NAME))
    .limit(1);
  if (marker[0]) {
    return { skipped: true, affected: 0, migrated: 0, needs_review: 0 };
  }

  const rows = await db
    .select({
      workflow_id: workflows.id,
      tenant_id: workflows.tenant_id,
      slug: workflows.slug,
      version: workflowVersions.version,
      dag: workflowVersions.dag,
    })
    .from(workflows) // tenant-filter:exempt — one-shot boot migration walks EVERY tenant
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(isNull(workflows.deleted_at));

  let affected = 0;
  let migrated = 0;
  let needsReview = 0;

  for (const row of rows) {
    // Cheap pre-filter: only scan definitions that declare kind:"loop".
    if (!JSON.stringify(row.dag).includes('"loop"')) continue;
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    if (!parsed.success) {
      // Leave workflows that fail current schema parsing untouched —
      // the item_var backfill already handles those; do not double-flag.
      continue;
    }
    const def = parsed.data;
    const hasLoop = def.steps.some((s) => s.kind === "loop");
    if (!hasLoop) continue;

    const rewrite = rewriteLoopsToForEach(def);

    if (!rewrite.ok) {
      // Hard structural error (e.g. body step missing) — flag as needs_review.
      affected++;
      needsReview++;
      await flagNeedsReview(db, {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        slug: row.slug,
        reason: rewrite.reason,
        loop_step_id: rewrite.loop_step_id,
      });
      continue;
    }

    if (!rewrite.changed) {
      // All loops in this workflow are ineligible (multi-body, complex
      // `over`, downstream scope reference). Leave on legacy path.
      continue;
    }

    affected++;

    try {
      await db.transaction(async (tx) => {
        const schedulesBefore = await scheduleRowCount(tx, row.tenant_id, row.workflow_id);
        const rotated = await rotateWorkflowVersionInternal(
          {
            tenant_id: row.tenant_id,
            workflow_id: row.workflow_id,
            def: rewrite.def,
            note: "loop-to-for-each-migration: loop steps rewritten to per-step for_each",
            audit_metadata: {
              kind: "loop_to_for_each_migration",
              from_version: row.version,
              changes: rewrite.changes,
            },
          },
          tx,
        );
        const schedulesAfter = await scheduleRowCount(tx, row.tenant_id, row.workflow_id);
        if (schedulesBefore !== schedulesAfter) {
          throw new Error(
            `workflows_schedules row-count parity violated (${schedulesBefore} → ${schedulesAfter})`,
          );
        }
        logger.info({
          module: "workflows",
          action: "workflow.loop_to_for_each_migration.rewritten",
          msg: "loop→for_each migration rotated workflow to the for_each contract",
          tenant_id: row.tenant_id,
          workflow_id: row.workflow_id,
          slug: row.slug,
          from_version: row.version,
          to_version: rotated.version,
          change_count: rewrite.changes.length,
          loop_step_ids: rewrite.changes.map((c) => c.loop_step_id),
        });
      });
      migrated++;
    } catch (err) {
      needsReview++;
      await flagNeedsReview(db, {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        slug: row.slug,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mark applied even when some workflows need review: the next boot
  // must not re-attempt the same rewrites (they would fail for the
  // same reasons). Needs-review cases require operator intervention.
  await db
    .insert(dataMigrations)
    .values({ name: LOOP_TO_FOR_EACH_BACKFILL_NAME })
    .onConflictDoNothing();

  logger.info({
    module: "workflows",
    action: "workflow.loop_to_for_each_migration.completed",
    msg: "loop→for_each backfill finished",
    affected,
    migrated,
    needs_review: needsReview,
  });
  return { skipped: false, affected, migrated, needs_review: needsReview };
}
