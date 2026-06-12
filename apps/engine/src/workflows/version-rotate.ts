// INTERNAL definition-only workflow version rotation — extracted from
// service.ts so the migration-facing write path has a single focused
// owner (and service.ts stays under the file-size invariant).

import { and, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { validateBareIterationIdentifiers } from "./reference-validator.ts";
import { type Executor, emitWorkflowLifecycle } from "./service.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

export interface RotateWorkflowVersionInternalInput {
  tenant_id: string;
  workflow_id: string;
  /** Fully-validated replacement definition. MUST carry the same
   *  `trigger` block as the current version — asserted below. */
  def: WorkflowDef;
  /** workflow_versions.note for the new row. */
  note: string;
  /** Extra audit metadata merged into the WORKFLOW_UPDATED row. */
  audit_metadata?: Record<string, unknown>;
}

/**
 * INTERNAL definition-only version rotation for engine-side migrations
 * (today: the item_var boot backfill). Unlike `updateWorkflow`, this
 * path NEVER calls `applyTriggerBindings`: the public update path
 * re-applies trigger bindings on every rotate, and for a
 * `kind: "request"` definition that tears down `workflows_schedules` /
 * `webhooks_inbound` rows — the known PUT-unbinds-schedules trap. A
 * migration that only rewrites step expressions must leave every
 * trigger binding row exactly as it found it, so instead of
 * preserve+restore we assert the trigger block is byte-identical and
 * skip binding reconciliation entirely.
 *
 * Throws on: workflow missing, validation failure, or a trigger
 * mismatch. Callers run it inside their own transaction so a throw
 * leaves the workflow untouched.
 */
export async function rotateWorkflowVersionInternal(
  input: RotateWorkflowVersionInternalInput,
  exec: Executor,
): Promise<{ version: number; version_id: string }> {
  const validation = validateWorkflowDef(input.def);
  if (!validation.ok || !validation.workflow) {
    throw new Error(
      `rotateWorkflowVersionInternal: definition failed validation: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }
  const def = validation.workflow;
  // Belt-and-suspenders for the item_var migration: even a rewrite that
  // passed the AST-equivalence proof must carry ZERO residual bare
  // iteration references — a ref the rewriter's walker missed would be
  // byte-identical in both ASTs (proof blind spot) yet unbound at
  // runtime. Any finding aborts the rotate; the caller flags
  // needs_review instead of committing a silently-broken definition.
  const bareRefs = validateBareIterationIdentifiers(
    def.steps as unknown as Array<Record<string, unknown>>,
  );
  if (bareRefs.length > 0) {
    throw new Error(
      `rotateWorkflowVersionInternal: definition carries bare iteration references: ${bareRefs
        .map((e) => `${e.step_id}.${e.field}: ${e.bad_reference}`)
        .join("; ")}`,
    );
  }
  const wfRows = await exec
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, input.tenant_id),
        eq(workflows.id, input.workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const wf = wfRows[0];
  if (!wf)
    throw new Error(`rotateWorkflowVersionInternal: workflow not found: ${input.workflow_id}`);
  if (!wf.current_version_id) {
    throw new Error("rotateWorkflowVersionInternal: workflow has no current version");
  }
  const currentRows = await exec
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, input.tenant_id),
        eq(workflowVersions.id, wf.current_version_id),
      ),
    )
    .limit(1);
  const current = currentRows[0];
  if (!current) throw new Error("rotateWorkflowVersionInternal: current version row missing");
  const currentDef = WorkflowDefSchema.parse(current.dag);
  const triggerOf = (d: WorkflowDef): unknown => d.trigger ?? { kind: "request" };
  if (JSON.stringify(triggerOf(def)) !== JSON.stringify(triggerOf(currentDef))) {
    throw new Error(
      "rotateWorkflowVersionInternal: trigger block differs from the current version — this path never reconciles trigger bindings, use updateWorkflow",
    );
  }
  const versionRows = (await exec
    .select({
      max_version: sql<number>`coalesce(max(${workflowVersions.version}), 0)`,
    })
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, input.tenant_id), eq(workflowVersions.workflow_id, wf.id)),
    )) as Array<{ max_version: number }>;
  const next = (versionRows[0]?.max_version ?? 0) + 1;
  const [v] = await exec
    .insert(workflowVersions)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      version: next,
      dag: def,
      note: input.note,
      // The migration does not change scope shapes — carry the recorded
      // scope_index forward so inspect_workflow / suggest_jsonata_paths
      // keep their evidence.
      ...(current.scope_index ? { scope_index: current.scope_index } : {}),
    })
    .returning();
  assertInsertRow(v, "workflow_versions");
  await exec
    .update(workflows)
    .set({ current_version_id: v.id, updated_at: new Date() })
    .where(eq(workflows.id, wf.id));
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.WORKFLOW_UPDATED,
      resource_type: "workflow",
      resource_id: wf.id,
      result: "success",
      metadata: { version: next, ...(input.audit_metadata ?? {}) },
    },
    exec,
  );
  await emitWorkflowLifecycle(exec, {
    tenant_id: input.tenant_id,
    type: "workflow.updated",
    payload: { workflow_id: wf.id, slug: wf.slug, version: next, actor_id: null },
  });
  log.workflow.committed({
    workflow_id: wf.id,
    tenant_id: input.tenant_id,
    slug: wf.slug,
    version: next,
    step_count: def.steps.length,
    actor_id: null,
  });
  return { version: next, version_id: v.id };
}
