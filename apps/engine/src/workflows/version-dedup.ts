// Workflow version idempotency — skip a redundant version rotation
// when a commit's definition is byte-identical to the current version.
//
// Extracted from `service.ts` so that file stays under the 1000-LOC
// audit-invariant ceiling. `updateWorkflow` is the sole caller; both
// the green-dry-run auto-persist and the `save_workflow_draft`
// re-issue route through it.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { WorkflowDef } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Per-step authoring metadata persisted alongside a workflow version
 *  (scope-shape hints from the last preview). Structurally identical to
 *  `UpdateWorkflowInput["scope_index"]`; inlined here to avoid a module
 *  cycle with `service.ts`. */
type ScopeIndex = Record<
  string,
  { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
> | null;

/**
 * Sorted-key JSON serialization. Postgres `jsonb` does not preserve
 * object key order, so a plain `JSON.stringify` of a stored `dag` would
 * report spurious differences against an in-memory `def`; sorting keys
 * makes the comparison structural.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * True when `def` is byte-identical to the workflow's current version
 * dag — the caller (`updateWorkflow`) must then skip the version insert
 * and the trigger rebind. Re-versioning identical content churns
 * version history, and `applyTriggerBindings` would unbind the
 * workflow's schedules on every redundant commit (a green dry_run of an
 * unchanged draft auto-persists through this path).
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
}): Promise<boolean> {
  if (!p.current_version_id) return false;
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
  if (!current || stableStringify(current.dag) !== stableStringify(p.def)) return false;
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
  return true;
}
