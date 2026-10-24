import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { emitWorkflowLifecycle } from "./service.ts";
import { executableDefinition, readStoredDefinition } from "./stored-definition.ts";
import { applyTriggerBindings, triggerOf } from "./trigger-bindings.ts";
import { writeWorkflowMetadata } from "./workflow-metadata.ts";

export async function activateReviewedDraft(
  tx: Executor,
  workflow: typeof workflows.$inferSelect,
  versionId: string,
  expectedCurrent: string | null,
  actorId: string,
  retry: boolean,
) {
  if (
    retry &&
    workflow.current_version_id === versionId &&
    workflow.draft_version_id === null &&
    workflow.lifecycle === "active"
  )
    return;
  if (
    workflow.current_version_id !== expectedCurrent ||
    workflow.draft_version_id !== versionId ||
    workflow.lifecycle === "archived"
  ) {
    throw Object.assign(new Error("The workflow changed; review the latest saved change again."), {
      code: "authority_activation_changed",
    });
  }
  const readVersion = async (id: string) => {
    const [row] = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, workflow.tenant_id),
          eq(workflowVersions.workflow_id, workflow.id),
          eq(workflowVersions.id, id),
        ),
      )
      .limit(1);
    return row;
  };
  const target = await readVersion(versionId);
  if (!target) throw new Error("reviewed workflow version unavailable");
  const definition = executableDefinition(target.dag);
  const previous = expectedCurrent ? await readVersion(expectedCurrent) : null;
  if (previous && previous.version > target.version) {
    throw Object.assign(
      new Error(
        "A newer version became active after this change was saved; reload and save it again.",
      ),
      { code: "authority_activation_changed" },
    );
  }
  const stored = previous ? readStoredDefinition(previous.dag) : null;
  const oldDefinition = stored && !stored.invalid ? stored.definition : null;
  await tx
    .update(workflows)
    .set({
      current_version_id: versionId,
      draft_version_id: null,
      lifecycle: "active",
      name: definition.name,
      updated_at: new Date(),
    })
    .where(and(eq(workflows.tenant_id, workflow.tenant_id), eq(workflows.id, workflow.id)));
  if (definition.description !== undefined) {
    await writeWorkflowMetadata(
      tx,
      workflow,
      { description: definition.description },
      { actor_id: actorId },
    );
  }
  if (
    !oldDefinition ||
    JSON.stringify(triggerOf(oldDefinition)) !== JSON.stringify(triggerOf(definition))
  ) {
    await applyTriggerBindings(
      tx,
      workflow.tenant_id,
      workflow.id,
      workflow.slug,
      definition,
      actorId,
    );
  }
  await auditAwait(
    {
      tenant_id: workflow.tenant_id,
      actor_type: "user",
      actor_id: actorId,
      action: AuditAction.WORKFLOW_UPDATED,
      resource_type: "workflow",
      resource_id: workflow.id,
      result: "success",
      metadata: {
        request_source: "ui",
        operation: "activate_reviewed_draft",
        previous_version_id: expectedCurrent,
        workflow_version_id: versionId,
      },
    },
    tx,
  );
  await emitWorkflowLifecycle(tx, {
    tenant_id: workflow.tenant_id,
    type: "workflow.updated",
    payload: {
      workflow_id: workflow.id,
      actor_id: actorId,
      slug: workflow.slug,
      version: target.version,
    },
  });
}
