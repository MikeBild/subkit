// Workflow version idempotency — skip a redundant version rotation
// when a commit's definition is byte-identical to the current version.
//
// Extracted from `service.ts` so that file stays under the 1000-LOC
// audit-invariant ceiling. Two callers: `updateWorkflow` (the version-
// rotation path, incl. the green-dry-run auto-persist) and
// `commitWorkflowAtomic`'s idempotent re-commit short-circuit. Both must
// destructure the returned `{ unchanged, current_def }`.

import { and, eq } from "drizzle-orm";

import type { Executor } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { canonicalWorkflowJson as stableStringify } from "./canonical-json.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";

/** Per-step authoring metadata persisted alongside a workflow version
 *  (scope-shape hints from the last preview). Structurally identical to
 *  `UpdateWorkflowInput["scope_index"]`; inlined here to avoid a module
 *  cycle with `service.ts`. */
type ScopeIndex = Record<
  string,
  { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
> | null;

/**
 * Returns `{ unchanged, current_def }`. `unchanged` is true when `def` is
 * byte-identical to the workflow's current version dag — the caller
 * (`updateWorkflow`) must then skip the version insert. `current_def` is the
 * parsed current version (null only when there is no current version), so the
 * caller can compare trigger blocks and reconcile bindings ONLY on a real
 * trigger change. Re-versioning identical content churns version history, and
 * an unconditional `applyTriggerBindings` would unbind the workflow's
 * schedules on every redundant commit (a green dry_run of an unchanged draft
 * auto-persists through this path).
 *
 * `def` and the stored dag are both post-`annotateRuntime`, so the
 * comparison is like-for-like. `scope_index` is per-step authoring
 * metadata, not workflow behaviour: when the def is unchanged but a
 * fresher scope index was supplied, it is written in place on the
 * current version rather than rotating to a new one.
 */
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
  // The stored dag was committed through this same schema, so parsing it back
  // is the inverse of the insert. The caller compares its `trigger` block to
  // decide whether a rotation must reconcile schedule/webhook bindings.
  const current_def = WorkflowDefSchema.parse(current.dag);
  if (stableStringify(current.dag) !== stableStringify(p.def)) {
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
