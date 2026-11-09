import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  type CatalogMetadataColumns,
  type CatalogMetadataPatch,
  DescriptionAcceptanceError,
  humanMetadataWrite,
  metadataChange,
} from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { type WorkflowLifecyclePayload, WorkflowLifecyclePayloadSchema } from "../pubsub/types.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import { carryApprovalsForward } from "./authority-inheritance.ts";
import { isValidSlug, toStoredDefinition, workflowSlug } from "./core/definition.ts";
import { carriedSpecColumns } from "./core/spec.ts";
import { decide, describeRejection, evolve, type WorkflowRejection } from "./core/workflow.ts";
import { prepareWorkflowSave } from "./prepare-save.ts";
import { loadWorkflowView } from "./read-projections.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import { slugConflictResult } from "./slug-conflict.ts";
import { readStoredDefinition } from "./stored-definition.ts";
import { applyTriggerBindings, triggerOf } from "./trigger-bindings.ts";
import { type VersionActor, versionAuthorColumns } from "./version-author.ts";
import { isUnchangedFromCurrentVersion } from "./version-dedup.ts";
import { loadVersionSpec } from "./version-spec.ts";
import {
  lockWorkflowForVersionWrite,
  nextVersionNumber,
  workflowStateOf,
} from "./version-write-lock.ts";
import type { WorkflowView } from "./view.ts";
import { writeWorkflowMetadata } from "./workflow-metadata.ts";

export type { WorkflowSummary } from "./workflow-queries.ts";
export {
  getWorkflow,
  getWorkflowBySlug,
  listWorkflowSummaries,
  listWorkflows,
} from "./workflow-queries.ts";
export type { WorkflowView };

export async function emitWorkflowLifecycle(
  tx: Executor,
  args: {
    tenant_id: string;
    type:
      | "workflow.created"
      | "workflow.updated"
      | "workflow.metadata_updated"
      | "workflow.deleted"
      | "workflow.version_restored";
    payload: WorkflowLifecyclePayload;
  },
): Promise<void> {
  const parsed = WorkflowLifecyclePayloadSchema.parse(args.payload);
  await writeEvent(tx, {
    tenant_id: args.tenant_id,
    channel: "workflow.lifecycle",
    type: args.type,
    payload: parsed as Record<string, unknown>,
  });
}

function slugFor(text: string): string {
  return workflowSlug(text, randomUUID().slice(0, 8));
}

function isPrimaryKeyConflict(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === "23505" && e.constraint === "workflows_pkey") return true;
    cur = e.cause;
  }
  return false;
}

interface CreateWorkflowInput extends VersionActor {
  tenant_id: string;
  def: unknown;
  workflow_id?: string;
  actor_id: string | null;
  metadata?: CatalogMetadataPatch;
  audit_metadata?: Record<string, unknown>;
  scope_index?: Record<
    string,
    { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
  > | null;
}

export async function createWorkflow(
  input: CreateWorkflowInput,
  db: Executor,
): Promise<{ workflow: WorkflowView; errors?: never } | { workflow?: never; errors: string[] }> {
  const prepared = await prepareWorkflowSave(input.def, input.tenant_id, db, {
    destinationTier: "tokens",
  });
  if (!prepared.ok) {
    if (prepared.stage === "definition") {
      log.workflow.validation.failed({
        tenant_id: input.tenant_id,
        op: "create",
        error_count: prepared.issues.length,
        first_error: prepared.issues[0]?.message ?? null,
      });
    }
    return { errors: prepared.errors };
  }
  const def = annotateRuntime(prepared.workflow);
  const slug = def.slug ?? slugFor(def.name);
  const metadata = humanMetadataWrite({
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...input.metadata,
  });
  const versionId = randomUUID();
  const created = decide(null, { type: "CreateWorkflow", version_id: versionId });
  if (!created.ok) return { errors: [describeRejection(created.rejection)] };
  const state = evolve(null, created.event);
  let result: string;
  try {
    result = await db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, input.tenant_id);
      const [wf] = await tx
        .insert(workflows)
        .values({
          ...(input.workflow_id ? { id: input.workflow_id } : {}),
          tenant_id: input.tenant_id,
          slug,
          name: def.name,
          ...metadata,
          lifecycle: state.lifecycle,
        })
        .returning();
      assertInsertRow(wf, "workflows");
      const [v] = await tx
        .insert(workflowVersions)
        .values({
          id: versionId,
          ...versionAuthorColumns(input),
          tenant_id: input.tenant_id,
          workflow_id: wf.id,
          version: 1,
          dag: toStoredDefinition(def, "version"),
          ...carriedSpecColumns(null),
          ...(input.scope_index ? { scope_index: input.scope_index } : {}),
        })
        .returning();
      assertInsertRow(v, "workflow_versions");
      await tx
        .update(workflows)
        .set({ current_version_id: state.current_version_id })
        .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)));
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...resolveActor({
            tenant_id: input.tenant_id,
            actor_id: input.actor_id,
            ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
          }),
          action: AuditAction.WORKFLOW_CREATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          metadata: {
            ...input.audit_metadata,
            slug,
            version: 1,
            ...(input.workflow_id ? { operator_chosen_id: true } : {}),
          },
        },
        tx,
      );
      await emitWorkflowLifecycle(tx, {
        tenant_id: input.tenant_id,
        type: "workflow.created",
        payload: { workflow_id: wf.id, slug, version: 1, actor_id: input.actor_id ?? null },
      });
      await applyTriggerBindings(
        tx,
        input.tenant_id,
        wf.id,
        slug,
        def,
        input.actor_id,
        input.actor_type,
      );
      return wf.id;
    });
  } catch (err) {
    if (input.workflow_id && isPrimaryKeyConflict(err))
      return { errors: ["id: this workflow id is already in use"] };
    const conflict = await slugConflictResult(err, db, input.tenant_id, slug);
    if (conflict) return { errors: conflict.errors };
    throw err;
  }
  log.workflow.committed({
    workflow_id: result,
    tenant_id: input.tenant_id,
    slug,
    version: 1,
    step_count: def.steps.length,
    actor_id: input.actor_id,
  });
  const view = await loadWorkflowView(input.tenant_id, result, db);
  if (!view) throw new Error("loadWorkflowView returned null after create");
  return { workflow: view };
}

export interface UpdateWorkflowInput extends VersionActor {
  tenant_id: string;
  id: string;
  def: unknown;
  actor_id: string | null;
  metadata?: CatalogMetadataPatch;
  scope_index?: Record<
    string,
    { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
  > | null;
}

export async function updateWorkflow(
  input: UpdateWorkflowInput,
  db: Executor,
): Promise<{ workflow: WorkflowView; errors?: never } | { workflow?: never; errors: string[] }> {
  const prepared = await prepareWorkflowSave(input.def, input.tenant_id, db, {
    destinationTier: "tokens",
  });
  if (!prepared.ok) {
    if (prepared.stage === "definition") {
      log.workflow.validation.failed({
        tenant_id: input.tenant_id,
        workflow_id: input.id,
        op: "update",
        error_count: prepared.issues.length,
        first_error: prepared.issues[0]?.message ?? null,
      });
    }
    return { errors: prepared.errors };
  }
  const def = annotateRuntime(prepared.workflow);
  const updated = await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, input.tenant_id);
    const wf = await lockWorkflowForVersionWrite(tx, input.tenant_id, input.id);
    if (!wf) return null;
    const dedup = await isUnchangedFromCurrentVersion({
      tx,
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      workflow_slug: wf.slug,
      current_version_id: wf.current_version_id,
      def,
      scope_index: input.scope_index,
    });
    await writeWorkflowMetadata(
      tx,
      wf,
      {
        ...(def.description !== undefined ? { description: def.description } : {}),
        ...input.metadata,
      },
      {
        actor_id: input.actor_id,
        ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
      },
    );
    if (dedup.unchanged) {
      return wf.id;
    }
    const versionId = randomUUID();
    const rotated = decide(workflowStateOf(wf), { type: "RotateVersion", version_id: versionId });
    if (!rotated.ok) return { rejection: rotated.rejection };
    const state = evolve(workflowStateOf(wf), rotated.event);
    const next = await nextVersionNumber(tx, input.tenant_id, wf.id);
    const baseSpec = await loadVersionSpec(tx, {
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      version_id: wf.current_version_id,
    });
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        id: versionId,
        ...versionAuthorColumns(input),
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: next,
        dag: toStoredDefinition(def, "version"),
        ...carriedSpecColumns(baseSpec),
        ...(input.scope_index ? { scope_index: input.scope_index } : {}),
      })
      .returning();
    assertInsertRow(v, "workflow_versions");
    await tx
      .update(workflows)
      .set({
        name: def.name,
        current_version_id: state.current_version_id,
        updated_at: new Date(),
      })
      .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)));
    await carryApprovalsForward(tx, {
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      from_version_id: wf.current_version_id,
      to_version_id: v.id,
      actor_id: input.actor_id ?? null,
      ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
    });
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        ...resolveActor({
          tenant_id: input.tenant_id,
          actor_id: input.actor_id,
          ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
        }),
        action: AuditAction.WORKFLOW_UPDATED,
        resource_type: "workflow",
        resource_id: wf.id,
        result: "success",
        metadata: { version: next },
      },
      tx,
    );
    await emitWorkflowLifecycle(tx, {
      tenant_id: input.tenant_id,
      type: "workflow.updated",
      payload: {
        workflow_id: wf.id,
        slug: wf.slug,
        version: next,
        actor_id: input.actor_id ?? null,
      },
    });
    log.workflow.committed({
      workflow_id: wf.id,
      tenant_id: input.tenant_id,
      slug: wf.slug,
      version: next,
      step_count: def.steps.length,
      actor_id: input.actor_id,
    });
    const triggerChanged =
      !dedup.current_def ||
      JSON.stringify(triggerOf(def)) !== JSON.stringify(triggerOf(dedup.current_def));
    if (triggerChanged) {
      await applyTriggerBindings(
        tx,
        input.tenant_id,
        wf.id,
        wf.slug,
        def,
        input.actor_id,
        input.actor_type,
      );
    }
    return wf.id;
  });
  if (!updated) return { errors: ["workflow not found"] };
  if (typeof updated !== "string") return { errors: [describeRejection(updated.rejection)] };
  const view = await loadWorkflowView(input.tenant_id, updated, db);
  if (!view) return { errors: ["workflow not found after update"] };
  return { workflow: view };
}

export interface UpdateWorkflowMetadataInput {
  accept_description?: boolean;
  tenant_id: string;
  id: string;
  slug?: string;
  name?: string;
  description?: string | null;
  category?: string | null;
  lifecycle?: "active" | "archived";
  expected_head_version_id?: string;
  actor_id: string | null;
  actor_type?: AuditActorType;
}

type UpdateWorkflowMetadataResult =
  | { workflow: WorkflowView; errors?: never }
  | {
      workflow?: never;
      errors: string[];
      code?: WorkflowRejection["code"];
      conflict?: { workflow_id: string; slug: string; name: string };
    };

export async function updateWorkflowMetadata(
  input: UpdateWorkflowMetadataInput,
  db: Executor,
): Promise<UpdateWorkflowMetadataResult> {
  const desiredSlug =
    typeof input.slug === "string" && input.slug.length > 0 ? slugFor(input.slug) : null;
  const desiredName =
    typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : null;
  const desiredLifecycle = input.lifecycle ?? null;
  const metadataInput: CatalogMetadataPatch = {
    ...(input.accept_description !== undefined
      ? { accept_description: input.accept_description }
      : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
  };
  const metadataProvided = Object.keys(metadataInput).length > 0;
  if (!desiredSlug && !desiredName && !desiredLifecycle && !metadataProvided) {
    return {
      errors: [
        "updateWorkflowMetadata requires at least one of slug, name, lifecycle, description, or category",
      ],
    };
  }
  if (desiredSlug && !isValidSlug(desiredSlug)) {
    return { errors: ["slug must be lowercase alphanumeric with hyphens"] };
  }
  try {
    const result = await db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, input.tenant_id);
      const wfRows = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, input.tenant_id),
            eq(workflows.id, input.id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1)
        .for("update");
      const wf = wfRows[0];
      const head = wf ? (wf.draft_version_id ?? wf.current_version_id) : null;
      if (!wf || (input.expected_head_version_id && head !== input.expected_head_version_id))
        return null;
      const lifecycleDecision =
        desiredLifecycle && desiredLifecycle !== wf.lifecycle
          ? decide(
              workflowStateOf(wf),
              desiredLifecycle === "archived"
                ? { type: "ArchiveWorkflow" }
                : { type: "RestoreWorkflow" },
            )
          : null;
      if (lifecycleDecision && !lifecycleDecision.ok)
        return { rejection: lifecycleDecision.rejection };
      const nextLifecycle = lifecycleDecision?.ok
        ? evolve(workflowStateOf(wf), lifecycleDecision.event).lifecycle
        : null;
      if (desiredSlug && desiredSlug !== wf.slug) {
        const conflictRows = await tx
          .select({ id: workflows.id, slug: workflows.slug, name: workflows.name })
          .from(workflows)
          .where(
            and(
              eq(workflows.tenant_id, input.tenant_id),
              eq(workflows.slug, desiredSlug),
              isNull(workflows.deleted_at),
            ),
          )
          .limit(1);
        const conflict = conflictRows[0];
        if (conflict && conflict.id !== wf.id) return { conflict };
      }
      const patch: {
        slug?: string;
        name?: string;
        lifecycle?: "draft" | "active" | "archived";
        updated_at: Date;
      } & CatalogMetadataColumns = {
        updated_at: new Date(),
        ...(metadataProvided ? metadataChange(wf, metadataInput) : null),
      };
      if (desiredSlug && desiredSlug !== wf.slug) patch.slug = desiredSlug;
      if (desiredName && desiredName !== wf.name) patch.name = desiredName;
      if (nextLifecycle) patch.lifecycle = nextLifecycle;
      if (
        patch.slug === undefined &&
        patch.name === undefined &&
        patch.description_source === undefined &&
        patch.category_source === undefined &&
        patch.lifecycle === undefined
      ) {
        return { id: wf.id, noop: true as const };
      }
      const [updatedMetadata] = await tx
        .update(workflows)
        .set(patch)
        .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, wf.id)))
        .returning({ category: workflows.category });
      if (patch.lifecycle === "archived") {
        await inboundService.unbindFromWorkflow(
          input.tenant_id,
          wf.id,
          {
            actor_id: input.actor_id ?? null,
            ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
          },
          tx,
        );
        await scheduleRepo.unbindFromWorkflow(
          tx,
          input.tenant_id,
          wf.id,
          input.actor_id ?? null,
          input.actor_type,
        );
      }
      if (patch.lifecycle === "active" && wf.lifecycle === "archived" && wf.current_version_id) {
        const [version] = await tx
          .select({ dag: workflowVersions.dag })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.tenant_id, input.tenant_id),
              eq(workflowVersions.id, wf.current_version_id),
            ),
          )
          .limit(1);
        const stored = version ? readStoredDefinition(version.dag) : null;
        if (stored && !stored.invalid)
          await applyTriggerBindings(
            tx,
            input.tenant_id,
            wf.id,
            patch.slug ?? wf.slug,
            stored.definition,
            input.actor_id ?? null,
            input.actor_type,
          );
      }
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          ...resolveActor({
            tenant_id: input.tenant_id,
            actor_id: input.actor_id,
            ...(input.actor_type !== undefined ? { actor_type: input.actor_type } : {}),
          }),
          action: AuditAction.WORKFLOW_UPDATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          metadata: {
            kind: "metadata",
            from: {
              slug: wf.slug,
              name: wf.name,
              description: wf.description ?? null,
              category: wf.category,
              lifecycle: wf.lifecycle,
            },
            to: {
              slug: patch.slug ?? wf.slug,
              name: patch.name ?? wf.name,
              description:
                patch.description === undefined ? (wf.description ?? null) : patch.description,
              category: updatedMetadata?.category ?? wf.category,
              lifecycle: patch.lifecycle ?? wf.lifecycle,
            },
          },
        },
        tx,
      );
      await emitWorkflowLifecycle(tx, {
        tenant_id: input.tenant_id,
        type: "workflow.metadata_updated",
        payload: {
          workflow_id: wf.id,
          slug: patch.slug ?? wf.slug,
          lifecycle: (patch.lifecycle ?? wf.lifecycle) as "draft" | "active" | "archived",
          actor_id: input.actor_id ?? null,
        },
      });
      log.workflow.committed({
        workflow_id: wf.id,
        tenant_id: input.tenant_id,
        slug: patch.slug ?? wf.slug,
        version: 0,
        step_count: 0,
        actor_id: input.actor_id,
      });
      return { id: wf.id, noop: false as const };
    });
    if (!result) return { errors: ["workflow not found"] };
    if ("rejection" in result) {
      return { errors: [describeRejection(result.rejection)], code: result.rejection.code };
    }
    if ("conflict" in result && result.conflict) {
      return {
        errors: [
          `slug "${desiredSlug}" already belongs to workflow "${result.conflict.name}" (id=${result.conflict.id})`,
        ],
        conflict: {
          workflow_id: result.conflict.id,
          slug: result.conflict.slug,
          name: result.conflict.name,
        },
      };
    }
    const view = await loadWorkflowView(input.tenant_id, result.id, db);
    if (!view) return { errors: ["workflow not found after rename"] };
    return { workflow: view };
  } catch (err) {
    if (err instanceof DescriptionAcceptanceError) throw err;
    if (desiredSlug) {
      const conflict = await slugConflictResult(err, db, input.tenant_id, desiredSlug);
      if (conflict) return conflict;
    }
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
}

export async function deleteWorkflow(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  db: Executor,
  actor_type?: AuditActorType,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(workflows)
      .set({ deleted_at: new Date() })
      .where(
        and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id), isNull(workflows.deleted_at)),
      )
      .returning();
    if (!row) return false;
    await inboundService.unbindFromWorkflow(
      tenant_id,
      row.id,
      { actor_id, ...(actor_type !== undefined ? { actor_type } : {}) },
      tx,
    );
    await scheduleRepo.unbindFromWorkflow(tx, tenant_id, row.id, actor_id, actor_type);
    await auditAwait(
      {
        tenant_id,
        ...resolveActor({
          tenant_id,
          actor_id,
          ...(actor_type !== undefined ? { actor_type } : {}),
        }),
        action: AuditAction.WORKFLOW_DELETED,
        resource_type: "workflow",
        resource_id: row.id,
        result: "success",
      },
      tx,
    );
    await emitWorkflowLifecycle(tx, {
      tenant_id,
      type: "workflow.deleted",
      payload: { workflow_id: row.id, slug: row.slug, actor_id: actor_id ?? null },
    });
    return true;
  });
}
