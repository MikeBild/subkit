// One-shot code backfill: rewrite stored CURRENT workflow versions off
// the retired `item_var` loop contract (`bare name` → `$item`).
//
// Runs in the migrations boot phase (called from `db/migrate.ts`
// `runMigrations` after the embedded SQL set has been applied), so it
// completes before any subsystem touches workflows — same guarantee the
// SQL backfills (e.g. 0019_files_unify) get from the drizzle journal.
// Because this backfill is TypeScript (it needs the jsonata AST
// rewriter), it cannot ride the journal; its idempotency marker is one
// row in `data_migrations` (created by SQL migration 0049), inserted
// only after the walk finishes. A present marker makes the next boot a
// no-op.
//
// Per-workflow contract:
//   - the rewriter must produce a PROVEN-equivalent definition
//     (AST structural equality modulo the name→$item mapping) AND the
//     rewritten definition must pass `validateWorkflowDef`, else the
//     workflow is left untouched, a
//     `workflow.itemvar_migration.needs_review` warn is logged, and an
//     audit row records the reason;
//   - the new version is written through
//     `rotateWorkflowVersionInternal` (definition-only rotate — it
//     NEVER reconciles trigger bindings, so `workflows_schedules` rows
//     survive; parity is additionally asserted inside the transaction);
//   - the audit row carries the before/after expression diffs.
//
// Failures never break boot: every workflow is processed in its own
// try/catch, and the caller wraps the whole backfill too.

import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { logger } from "../../logging/logger.ts";
import { rewriteWorkflowItemVars } from "../../workflows/itemvar-rewrite.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { rotateWorkflowVersionInternal } from "../../workflows/version-rotate.ts";
import type { Db } from "../client.ts";
import {
  dataMigrations,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../schema/index.ts";

export const ITEMVAR_BACKFILL_NAME = "itemvar_rewrite_v1";

export interface ItemvarBackfillReport {
  /** True when the marker row already existed — nothing was scanned. */
  skipped: boolean;
  /** Workflows whose current version declared item_var. */
  affected: number;
  migrated: number;
  needs_review: number;
}

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    step_id?: string | undefined;
    field?: string | undefined;
  },
): Promise<void> {
  logger.warn({
    module: "workflows",
    action: "workflow.itemvar_migration.needs_review",
    msg: "item_var migration left workflow untouched — manual review required",
    tenant_id: args.tenant_id,
    workflow_id: args.workflow_id,
    slug: args.slug,
    reason: args.reason,
    ...(args.step_id ? { step_id: args.step_id } : {}),
    ...(args.field ? { field: args.field } : {}),
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
        kind: "itemvar_migration_needs_review",
        reason: args.reason,
        ...(args.step_id ? { step_id: args.step_id } : {}),
        ...(args.field ? { field: args.field } : {}),
      },
    },
    db,
  );
}

/**
 * Walk every live workflow's CURRENT version; definitions whose loop
 * steps declare `item_var` are rewritten to the `$item` contract and
 * committed as a new version. Historical version rows stay immutable —
 * executions pinned to a `version_id` keep the bare binding via the
 * conditional in `execution/loop-scope.ts`.
 */
export async function runItemvarBackfill(db: Db): Promise<ItemvarBackfillReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger; markers are instance-global by design
    .where(eq(dataMigrations.name, ITEMVAR_BACKFILL_NAME))
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
    .from(workflows) // tenant-filter:exempt — one-shot boot migration walks EVERY tenant; each rewrite tx is tenant-scoped via the row's tenant_id
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(isNull(workflows.deleted_at));

  let affected = 0;
  let migrated = 0;
  let needsReview = 0;

  for (const row of rows) {
    // Cheap pre-filter before the Zod parse: only definitions that
    // mention the field at all are candidates.
    if (!JSON.stringify(row.dag).includes('"item_var"')) continue;
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    if (!parsed.success) {
      affected++;
      needsReview++;
      await flagNeedsReview(db, {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        slug: row.slug,
        reason: `stored definition failed WorkflowDefSchema parse: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
      continue;
    }
    const def = parsed.data;
    const declares = def.steps.some(
      (s) => s.kind === "loop" && typeof (s as { item_var?: string }).item_var === "string",
    );
    if (!declares) continue;
    affected++;

    const rewrite = rewriteWorkflowItemVars(def);
    if (!rewrite.ok) {
      needsReview++;
      await flagNeedsReview(db, {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        slug: row.slug,
        reason: rewrite.reason,
        step_id: rewrite.step_id,
        field: rewrite.field,
      });
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        const schedulesBefore = await scheduleRowCount(tx, row.tenant_id, row.workflow_id);
        const rotated = await rotateWorkflowVersionInternal(
          {
            tenant_id: row.tenant_id,
            workflow_id: row.workflow_id,
            def: rewrite.def,
            note: "itemvar-migration: bare item_var references rewritten to $item",
            audit_metadata: {
              kind: "itemvar_migration",
              from_version: row.version,
              // Before/after expression diffs — the audit trail is the
              // operator's review surface for this migration.
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
          action: "workflow.itemvar_migration.rewritten",
          msg: "item_var migration rotated workflow to the $item contract",
          tenant_id: row.tenant_id,
          workflow_id: row.workflow_id,
          slug: row.slug,
          from_version: row.version,
          to_version: rotated.version,
          change_count: rewrite.changes.length,
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

  // Mark applied even when some workflows are flagged: needs_review is
  // an operator signal, not a retry queue — re-running the same
  // rewriter on the next boot would flag the same workflows again.
  await db.insert(dataMigrations).values({ name: ITEMVAR_BACKFILL_NAME }).onConflictDoNothing();

  logger.info({
    module: "workflows",
    action: "workflow.itemvar_migration.completed",
    msg: "item_var backfill finished",
    affected,
    migrated,
    needs_review: needsReview,
  });
  return { skipped: false, affected, migrated, needs_review: needsReview };
}
