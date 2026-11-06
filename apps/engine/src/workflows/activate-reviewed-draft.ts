import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { decide, describeRejection, evolve } from "./core/workflow.ts";
import { emitWorkflowLifecycle } from "./service.ts";
import { executableDefinition, readStoredDefinition } from "./stored-definition.ts";
import { applyTriggerBindings, triggerOf } from "./trigger-bindings.ts";
import { workflowStateOf } from "./version-write-lock.ts";
import { writeWorkflowMetadata } from "./workflow-metadata.ts";

export async function activateReviewedDraft(
  tx: Executor,
  workflow: typeof workflows.$inferSelect,
  versionId: string,
  expectedCurrent: string | null,
  actorId: string,
  retry: boolean,
  review: { manifestDigestMatches: boolean },
) {
  if (
    retry &&
    workflow.current_version_id === versionId &&
    workflow.draft_version_id === null &&
    workflow.lifecycle === "active"
  )
    return;
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
  const previous = expectedCurrent ? await readVersion(expectedCurrent) : null;
  const state = workflowStateOf(workflow);
  const decision = decide(
    state,
    { type: "ActivateDraft", version_id: versionId },
    {
      manifestDigestMatches: review.manifestDigestMatches,
      expectedCurrentVersionId: expectedCurrent,
      previousVersionIsNewer: Boolean(previous && target && previous.version > target.version),
    },
  );
  if (!decision.ok) {
    throw Object.assign(new Error(describeRejection(decision.rejection)), {
      code:
        decision.rejection.code === "manifest_changed"
          ? "authority_manifest_changed"
          : "authority_activation_changed",
    });
  }
  if (!target) throw new Error("reviewed workflow version unavailable");
  const definition = executableDefinition(target.dag);
  const stored = previous ? readStoredDefinition(previous.dag) : null;
  const oldDefinition = stored && !stored.invalid ? stored.definition : null;
  const next = evolve(state, decision.event);
  await tx
    .update(workflows)
    .set({
      current_version_id: next.current_version_id,
      draft_version_id: next.draft_version_id,
      lifecycle: next.lifecycle,
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
