import type { Db } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { rewriteStoredRequestProtocols } from "../core/request-protocol.ts";
import { WorkflowDefSchema } from "../types.ts";
import {
  backfillAlreadyRan,
  markBackfillRan,
  rewriteVersionDefinition,
  type VersionDefinitionRow,
  versionDefinitionRows,
} from "./persistence/definition-rows.ts";
import { rotateCurrentVersion } from "./rotate-current-version.ts";

export const REQUEST_PROTOCOL_V1_BACKFILL_NAME = "request_protocol_v1";

export interface RequestProtocolV1Report {
  skipped: boolean;
  rewritten: number;
  rotated: number;
  left_in_old_format: number;
}

async function rotate(db: Db, row: VersionDefinitionRow, dag: unknown): Promise<boolean> {
  const parsed = WorkflowDefSchema.safeParse(dag);
  if (!parsed.success) return false;
  try {
    await rotateCurrentVersion(db, {
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      def: parsed.data,
      note: "request-protocol-migration: request steps name their protocol",
      audit_metadata: { kind: "request_protocol_migration", from_version: row.version },
    });
    return true;
  } catch (err) {
    logger.warn({
      module: "workflows",
      action: "workflow.request_protocol_migration.rotation_failed",
      msg: "request protocol migration could not rotate an approved version",
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      slug: row.slug,
      version: row.version,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function runRequestProtocolV1Backfill(db: Db): Promise<RequestProtocolV1Report> {
  if (await backfillAlreadyRan(db, REQUEST_PROTOCOL_V1_BACKFILL_NAME)) {
    return { skipped: true, rewritten: 0, rotated: 0, left_in_old_format: 0 };
  }
  let rewritten = 0;
  let rotated = 0;
  let leftInOldFormat = 0;
  for (const row of await versionDefinitionRows(db)) {
    const rewrite = rewriteStoredRequestProtocols(row.dag);
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
      action: "workflow.request_protocol_migration.left_in_old_format",
      msg: "an approved workflow version keeps its earlier request format and cannot run",
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      slug: row.slug,
      version: row.version,
      current: row.current,
    });
  }
  await markBackfillRan(db, REQUEST_PROTOCOL_V1_BACKFILL_NAME);
  logger.info({
    module: "workflows",
    action: "workflow.request_protocol_migration.completed",
    msg: "request protocol backfill finished",
    rewritten,
    rotated,
    left_in_old_format: leftInOldFormat,
  });
  return { skipped: false, rewritten, rotated, left_in_old_format: leftInOldFormat };
}
