import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  definitionWithoutDescription,
  canonicalWorkflowJson as stableStringify,
} from "./canonical-json.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

type ScopeIndex = Record<
  string,
  { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
> | null;

export async function isUnchangedFromCurrentVersion(p: {
  tx: Executor;
  tenant_id: string;
  workflow_id: string;
  workflow_slug: string;
  current_version_id: string | null;
  def: WorkflowDef;
  scope_index: ScopeIndex | undefined;
}): Promise<{ unchanged: boolean; current_def: WorkflowDef | null }> {
  if (!p.current_version_id) return { unchanged: false, current_def: null };
  const rows = await p.tx
    .select({
      dag: workflowVersions.dag,
      version: workflowVersions.version,
      scope_index: workflowVersions.scope_index,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, p.tenant_id),
        eq(workflowVersions.id, p.current_version_id),
      ),
    )
    .limit(1);
  const current = rows[0];
  if (!current) return { unchanged: false, current_def: null };
  const current_def = WorkflowDefSchema.parse(current.dag);
  if (
    stableStringify(definitionWithoutDescription(current.dag)) !==
    stableStringify(definitionWithoutDescription(p.def))
  ) {
    return { unchanged: false, current_def };
  }
  if (
    p.scope_index !== undefined &&
    stableStringify(p.scope_index) !== stableStringify(current.scope_index ?? null)
  ) {
    await p.tx
      .update(workflowVersions)
      .set({ scope_index: p.scope_index })
      .where(eq(workflowVersions.id, p.current_version_id));
  }
  logger.info({
    module: "workflow",
    action: "update.unchanged",
    msg: "workflow def unchanged — skipped redundant version rotation",
    tenant_id: p.tenant_id,
    workflow_id: p.workflow_id,
    slug: p.workflow_slug,
    version: current.version,
  });
  return { unchanged: true, current_def };
}
