import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { logger } from "../../logging/logger.ts";
import {
  rewriteLoopsToForEach,
  type WorkflowLoopToForEachRewrite,
} from "../../workflows/migrate-loop-to-for-each.ts";
import { loadTenantWorkflowHeaderPolicies } from "../../workflows/tenant-validator.ts";
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
  skipped: boolean;
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
    if (!JSON.stringify(row.dag).includes('"loop"')) continue;
    const parsed = WorkflowDefSchema.safeParse(row.dag);
    if (!parsed.success) {
      continue;
    }
    const def = parsed.data;
    const hasLoop = def.steps.some((s) => s.kind === "loop");
    if (!hasLoop) continue;

    let rewrite: WorkflowLoopToForEachRewrite;
    try {
      const connectorHeaderPolicies = await loadTenantWorkflowHeaderPolicies(
        def,
        row.tenant_id,
        db,
      );
      rewrite = rewriteLoopsToForEach(def, { connectorHeaderPolicies });
    } catch {
      rewrite = { ok: false, reason: "connector authentication could not be validated" };
    }

    if (!rewrite.ok) {
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
