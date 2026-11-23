import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { Db } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import {
  hasStoredLoopStep,
  type LoopToForEachChange,
  loopRewriteMessage,
  rewriteStoredLoops,
} from "../core/loop-rewrite.ts";
import { loadTenantWorkflowHeaderPolicies } from "../tenant-validator.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";
import {
  backfillAlreadyRan,
  type CurrentDefinitionRow,
  currentDefinitionRows,
  markBackfillRan,
} from "./persistence/definition-rows.ts";
import { rotateCurrentVersion } from "./rotate-current-version.ts";

export const LOOP_TO_FOR_EACH_V2_BACKFILL_NAME = "loop_to_for_each_v2";

export interface LoopToForEachV2Report {
  skipped: boolean;
  affected: number;
  migrated: number;
  needs_review: number;
}

type Conversion =
  | { ok: true; def: WorkflowDef; changes: LoopToForEachChange[] }
  | { ok: false; reason: string; loop_step_id?: string };

async function convert(db: Db, row: CurrentDefinitionRow): Promise<Conversion> {
  const rewrite = rewriteStoredLoops(row.dag);
  const blocked = rewrite.blocked[0];
  if (blocked) {
    return {
      ok: false,
      reason: loopRewriteMessage(blocked.reason),
      loop_step_id: blocked.loop_step_id,
    };
  }
  const parsed = WorkflowDefSchema.safeParse(rewrite.dag);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `rewritten definition is not a valid workflow: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  let connectorHeaderPolicies: Awaited<ReturnType<typeof loadTenantWorkflowHeaderPolicies>>;
  try {
    connectorHeaderPolicies = await loadTenantWorkflowHeaderPolicies(
      parsed.data,
      row.tenant_id,
      db,
    );
  } catch {
    return { ok: false, reason: "connector authentication could not be validated" };
  }
  const validation = validateWorkflowDef(parsed.data, { connectorHeaderPolicies });
  if (!validation.ok || !validation.workflow) {
    return {
      ok: false,
      reason: `rewritten definition failed validation: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, def: validation.workflow, changes: rewrite.changes };
}

async function flagNeedsReview(
  db: Db,
  row: CurrentDefinitionRow,
  reason: string,
  loop_step_id?: string,
): Promise<void> {
  logger.warn({
    module: "workflows",
    action: "workflow.loop_to_for_each_migration.needs_review",
    msg: "loop→for_each migration left workflow untouched — manual review required",
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    slug: row.slug,
    reason,
    ...(loop_step_id ? { loop_step_id } : {}),
  });
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.WORKFLOW_UPDATED,
      resource_type: "workflow",
      resource_id: row.workflow_id,
      result: "error",
      metadata: {
        kind: "loop_to_for_each_migration_needs_review",
        reason,
        ...(loop_step_id ? { loop_step_id } : {}),
      },
    },
    db,
  );
}

async function rotate(db: Db, row: CurrentDefinitionRow, conversion: Conversion & { ok: true }) {
  const rotated = await rotateCurrentVersion(db, {
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    def: conversion.def,
    note: "loop-to-for-each-migration: loop steps rewritten to per-step for_each",
    audit_metadata: {
      kind: "loop_to_for_each_migration",
      from_version: row.version,
      changes: conversion.changes,
    },
  });
  logger.info({
    module: "workflows",
    action: "workflow.loop_to_for_each_migration.rewritten",
    msg: "loop→for_each migration rotated workflow to the for_each contract",
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    slug: row.slug,
    from_version: row.version,
    to_version: rotated.version,
    change_count: conversion.changes.length,
    loop_step_ids: conversion.changes.map((change) => change.loop_step_id),
  });
}

export async function runLoopToForEachV2Backfill(db: Db): Promise<LoopToForEachV2Report> {
  if (await backfillAlreadyRan(db, LOOP_TO_FOR_EACH_V2_BACKFILL_NAME)) {
    return { skipped: true, affected: 0, migrated: 0, needs_review: 0 };
  }
  let affected = 0;
  let migrated = 0;
  let needsReview = 0;
  for (const row of await currentDefinitionRows(db)) {
    if (!hasStoredLoopStep(row.dag)) continue;
    affected++;
    const conversion = await convert(db, row);
    if (!conversion.ok) {
      needsReview++;
      await flagNeedsReview(db, row, conversion.reason, conversion.loop_step_id);
      continue;
    }
    try {
      await rotate(db, row, conversion);
      migrated++;
    } catch (err) {
      needsReview++;
      await flagNeedsReview(db, row, err instanceof Error ? err.message : String(err));
    }
  }
  await markBackfillRan(db, LOOP_TO_FOR_EACH_V2_BACKFILL_NAME);
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
