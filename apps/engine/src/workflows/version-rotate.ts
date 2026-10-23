import { and, eq, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { carryApprovalsForward } from "./authority-inheritance.ts";
import { validateBareIterationIdentifiers } from "./reference-validator.ts";
import { emitWorkflowLifecycle } from "./service.ts";
import { validateTenantWorkflowDefForSave } from "./tenant-validator.ts";
import { triggerOf } from "./trigger-bindings.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";

export interface RotateWorkflowVersionInternalInput {
  tenant_id: string;
  workflow_id: string;
  def: WorkflowDef;
  note: string;
  audit_metadata?: Record<string, unknown>;
}

export async function rotateWorkflowVersionInternal(
  input: RotateWorkflowVersionInternalInput,
  exec: Executor,
): Promise<{ version: number; version_id: string }> {
  const validation = await validateTenantWorkflowDefForSave(input.def, input.tenant_id, exec);
  if (!validation.ok || !validation.workflow) {
    throw new Error(
      `rotateWorkflowVersionInternal: definition failed validation: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  }
  const def = validation.workflow;
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
  const wf = await lockWorkflowForVersionWrite(exec, input.tenant_id, input.workflow_id);
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
      author_user_id: null,
      author_system_account_id: null,
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      version: next,
      dag: def,
      note: input.note,
      ...(current.scope_index ? { scope_index: current.scope_index } : {}),
    })
    .returning();
  assertInsertRow(v, "workflow_versions");
  await exec
    .update(workflows)
    .set({ current_version_id: v.id, updated_at: new Date() })
    .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)));
  await carryApprovalsForward(exec, {
    tenant_id: input.tenant_id,
    workflow_id: wf.id,
    from_version_id: wf.current_version_id,
    to_version_id: v.id,
    actor_id: null,
  });
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
