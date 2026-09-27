// Patch-candidate fixtures that readiness can actually evaluate.
//
// An open decision is `proposed` AND reviewable on the workflow's current
// version, so a fixture that only inserts a `proposed` row with a bare
// description is no longer a decision anybody can make — it has no step to
// rewrite. These helpers seed a workflow whose current version carries the one
// step the proposals below rewrite, and the diffs that make a candidate
// reviewable (a real path move) or provably undecidable (a move to itself).

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";

export const PATCHABLE_STEP_ID = "read";

export function patchableDag(dataSelector = "data.id") {
  return { steps: [{ id: PATCHABLE_STEP_ID, kind: "request", data_selector: dataSelector }] };
}

/** A workflow whose current version holds the step the fixtures patch. */
export async function seedPatchableWorkflow(
  db: Db,
  tenant_id: string,
  slug: string,
  name = slug,
): Promise<{ workflow_id: string; version_id: string }> {
  const [wf] = await db
    .insert(workflows)
    .values({ tenant_id, slug, name, lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("workflow insert returned no row");
  const version_id = await addWorkflowVersion(db, tenant_id, wf.id, 1);
  return { workflow_id: wf.id, version_id };
}

/** Write a new version and make it current — what a workflow edit does. */
export async function addWorkflowVersion(
  db: Db,
  tenant_id: string,
  workflow_id: string,
  version: number,
  dataSelector = "data.id",
): Promise<string> {
  const [ver] = await db
    .insert(workflowVersions)
    .values({ tenant_id, workflow_id, version, dag: patchableDag(dataSelector) })
    .returning();
  if (!ver) throw new Error("workflow version insert returned no row");
  await db
    .update(workflows)
    .set({ current_version_id: ver.id })
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, workflow_id)));
  return ver.id;
}

function proposal(description: string, value: string) {
  return {
    classification: "safe" as const,
    kind: "update_field_path" as const,
    description,
    reasoning: "fixture",
    patch: { op: "replace", path: "/data/id", value },
  };
}

/** A proposal the current version can take: `data.id` moves to `data.result.id`. */
export function reviewableDiff(description: string, extra: Record<string, unknown> = {}) {
  return {
    proposal: proposal(description, "data/result/id"),
    workflow_step_id: PATCHABLE_STEP_ID,
    ...extra,
  };
}

/** A proposal that moves `data.id` to itself — readiness `no_change`. */
export function noChangeDiff(description: string, extra: Record<string, unknown> = {}) {
  return {
    proposal: proposal(description, "data/id"),
    workflow_step_id: PATCHABLE_STEP_ID,
    ...extra,
  };
}
