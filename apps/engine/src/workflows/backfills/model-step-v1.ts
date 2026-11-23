import type { Db } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { rewriteStoredModelSteps } from "../core/model-step-rewrite.ts";
import { WorkflowDefSchema } from "../types.ts";
import {
  backfillAlreadyRan,
  markBackfillRan,
  rewriteVersionDefinition,
  type VersionDefinitionRow,
  versionDefinitionRows,
} from "./persistence/definition-rows.ts";
import { rotateCurrentVersion } from "./rotate-current-version.ts";

export const MODEL_STEP_V1_BACKFILL_NAME = "model_step_v1";

export interface ModelStepV1Report {
  skipped: boolean;
  rewritten: number;
  rotated: number;
  left_in_old_format: number;
  kept_as_request: number;
}

async function rotate(db: Db, row: VersionDefinitionRow, dag: unknown): Promise<boolean> {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (!parsed.success) return false;
  try {
    await rotateCurrentVersion(db, {
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      def: parsed.data,
      note: "model-step-migration: provider calls become model steps",
      audit_metadata: { kind: "model_step_migration", from_version: row.version },
    });
    return true;
  } catch (err) {
    logger.warn({
      module: "workflows",
      action: "workflow.model_step_migration.rotation_failed",
      msg: "model step migration could not rotate an approved version",
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      slug: row.slug,
      version: row.version,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function runModelStepV1Backfill(db: Db): Promise<ModelStepV1Report> {
  if (await backfillAlreadyRan(db, MODEL_STEP_V1_BACKFILL_NAME)) {
    return { skipped: true, rewritten: 0, rotated: 0, left_in_old_format: 0, kept_as_request: 0 };
  }
  let rewritten = 0;
  let rotated = 0;
  let leftInOldFormat = 0;
  let keptAsRequest = 0;
  for (const row of await versionDefinitionRows(db)) {
    const rewrite = rewriteStoredModelSteps(row.dag);
    keptAsRequest += rewrite.skipped.length;
    for (const skip of rewrite.skipped) {
      logger.info({
        module: "workflows",
        action: "workflow.model_step_migration.kept_as_request",
        msg: "a provider call stays a request step because it cannot be carried over unchanged",
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        version: row.version,
        step_id: skip.step_id,
        reason: skip.reason,
      });
    }
    if (!rewrite.changed) continue;
    const outcome = await rewriteVersionDefinition(db, row, rewrite.dag);
    if (outcome === "rewritten") {
      rewritten++;
      continue;
    }
    if (row.current && (await rotate(db, row, rewrite.dag))) {
      rotated++;
      continue;
    }
    leftInOldFormat++;
    logger.warn({
      module: "workflows",
      action: "workflow.model_step_migration.left_in_old_format",
      msg: "an approved workflow version keeps its provider request steps",
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      slug: row.slug,
      version: row.version,
      current: row.current,
    });
  }
  await markBackfillRan(db, MODEL_STEP_V1_BACKFILL_NAME);
  logger.info({
    module: "workflows",
    action: "workflow.model_step_migration.completed",
    msg: "model step backfill finished",
    rewritten,
    rotated,
    left_in_old_format: leftInOldFormat,
    kept_as_request: keptAsRequest,
  });
  return {
    skipped: false,
    rewritten,
    rotated,
    left_in_old_format: leftInOldFormat,
    kept_as_request: keptAsRequest,
  };
}
