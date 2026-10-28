import type { WorkflowOperatingStatus } from "@shared/workflow-operating-status.ts";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  type CatalogMetadataColumns,
  type CatalogMetadataPatch,
  type CatalogSource,
  catalogMetadataView,
  DescriptionAcceptanceError,
  humanMetadataWrite,
  metadataChange,
} from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Executor, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import {
  catalogGroupOrder,
  type ListResult,
  resolveWindowTotal,
  totalOverWindow,
} from "../db/list-result.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { type WorkflowLifecyclePayload, WorkflowLifecyclePayloadSchema } from "../pubsub/types.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import { carryApprovalsForward } from "./authority-inheritance.ts";
import { definitionWithoutDescription, workflowJsonDigest } from "./canonical-json.ts";
import {
  buildWorkflowListConds,
  countWorkflows,
  type ListWorkflowsOptions,
  resolveCatalogFilter,
  WORKFLOW_LIST_MAX_LIMIT,
} from "./catalog-view.ts";
import { applySkillSchemaGate, applyStorageBindingGate } from "./commit-gates.ts";
import {
  connectorReferencesForDefinition,
  loadConnectorReferenceRecords,
  type WorkflowConnectorReference,
} from "./connector-refs.ts";
import {
  loadWorkflowOperatingStates,
  type WorkflowAuthorityEnvironmentSummary,
} from "./operating-status.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import { slugConflictResult } from "./slug-conflict.ts";
import { invalidDefinitionForRead, readStoredDefinition } from "./stored-definition.ts";
import { validateTenantWorkflowDefForSave } from "./tenant-validator.ts";
import { applyTriggerBindings, triggerOf } from "./trigger-bindings.ts";
import type { WorkflowDef } from "./types.ts";
import {
  readVersionAuthor,
  type VersionActor,
  type VersionAuthor,
  versionAuthorColumns,
} from "./version-author.ts";
import { isUnchangedFromCurrentVersion } from "./version-dedup.ts";
import { carriedSpecColumns, loadVersionSpec } from "./version-spec.ts";
import { lockWorkflowForVersionWrite } from "./version-write-lock.ts";
import { writeWorkflowMetadata } from "./workflow-metadata.ts";

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

export interface WorkflowView {
  operating_status?: WorkflowOperatingStatus;
  authority_environments?: Record<"dev" | "prod", WorkflowAuthorityEnvironmentSummary | null>;
  connector_references: WorkflowConnectorReference[];
  creator: VersionAuthor;
  checksum: string | null;
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  description_source: CatalogSource;
  category: string;
  category_source: CatalogSource;
  lifecycle: "draft" | "active" | "archived";
  current_version_id: string | null;
  draft_version_id?: string | null;
  current_version: number | null;
  created_at: Date;
  updated_at: Date;
  last_executed_at: Date | null;
  health_state: string;
  health_reason: string | null;
  health_changed_at: Date | null;
  invalid: boolean;
  definition: WorkflowDef;
  steps: WorkflowDef["steps"];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || `wf-${Math.random().toString(36).slice(2, 8)}`
  );
}

async function loadWorkflowView(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<WorkflowView | null> {
  const rows = await exec
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id), isNull(workflows.deleted_at)),
    )
    .limit(1);
  return (await workflowViewsFromRows(tenant_id, rows, exec))[0] ?? null;
}

async function workflowViewsFromRows(
  tenant_id: string,
  rows: Array<typeof workflows.$inferSelect>,
  exec: Executor,
): Promise<WorkflowView[]> {
  const versionIds = rows.flatMap((wf) => (wf.current_version_id ? [wf.current_version_id] : []));
  const workflowIds = rows.map((wf) => wf.id);
  const versions = workflowIds.length
    ? await exec
        .select({
          id: workflowVersions.id,
          workflow_id: workflowVersions.workflow_id,
          author_user_id: workflowVersions.author_user_id,
          author_system_account_id: workflowVersions.author_system_account_id,
          version: workflowVersions.version,
          dag: workflowVersions.dag,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            inArray(workflowVersions.workflow_id, workflowIds),
            or(
              eq(workflowVersions.version, 1),
              ...(versionIds.length ? [inArray(workflowVersions.id, versionIds)] : []),
            ),
          ),
        )
    : [];
  const connectorRecords = rows.length ? await loadConnectorReferenceRecords(tenant_id, exec) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const originals = new Map(versions.filter((v) => v.version === 1).map((v) => [v.workflow_id, v]));
  return rows.map((wf) => {
    const current = wf.current_version_id ? byId.get(wf.current_version_id) : undefined;
    const v = current?.workflow_id === wf.id ? current : undefined;
    const original = originals.get(wf.id);
    const stored = v ? readStoredDefinition(v.dag) : null;
    const storedDef: WorkflowDef = stored
      ? stored.invalid
        ? invalidDefinitionForRead(v?.dag, wf.name)
        : stored.definition
      : ({ name: wf.name, steps: [] } as WorkflowDef);
    const withoutDescription = definitionWithoutDescription(storedDef);
    const def: WorkflowDef = wf.description
      ? { ...withoutDescription, description: wf.description }
      : withoutDescription;
    const metadata = catalogMetadataView(wf);
    return {
      id: wf.id,
      connector_references: connectorReferencesForDefinition(v?.dag, connectorRecords),
      creator: original ? readVersionAuthor(original) : null,
      checksum: v ? workflowJsonDigest(v.dag) : null,
      tenant_id: wf.tenant_id,
      slug: wf.slug,
      name: wf.name,
      description: metadata.description,
      description_source: metadata.description_source,
      category: metadata.category,
      category_source: metadata.category_source,
      lifecycle: wf.lifecycle as "draft" | "active" | "archived",
      current_version_id: wf.current_version_id,
      draft_version_id: wf.draft_version_id,
      current_version: v?.version ?? null,
      created_at: wf.created_at,
      updated_at: wf.updated_at,
      last_executed_at: wf.last_executed_at ?? null,
      health_state: wf.health_state,
      health_reason: wf.health_reason ?? null,
      health_changed_at: wf.health_changed_at ?? null,
      invalid: stored?.invalid ?? false,
      definition: def,
      steps: def.steps,
    };
  });
}

function isPrimaryKeyConflict(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === "23505" && e.constraint === "workflows_pkey") return true;
    cur = e.cause;
  }
  return false;
}

export interface CreateWorkflowInput extends VersionActor {
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
  exec?: Executor,
): Promise<{ workflow: WorkflowView; errors?: never } | { workflow?: never; errors: string[] }> {
  const db = exec ?? getDb();
  const validation = await validateTenantWorkflowDefForSave(input.def, input.tenant_id, db, {
    destinationTier: "tokens",
  });
  if (!validation.ok || !validation.workflow) {
    log.workflow.validation.failed({
      tenant_id: input.tenant_id,
      op: "create",
      error_count: validation.errors.length,
      first_error: validation.errors[0]?.message ?? null,
    });
    return { errors: validation.errors.map((e) => `${e.path}: ${e.message}`) };
  }
  const skillGate = await applySkillSchemaGate(input.tenant_id, validation.workflow, db);
  if (!skillGate.ok) return { errors: skillGate.errors };
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, db);
  if (!storageGate.ok) return { errors: storageGate.errors };
  const def = annotateRuntime(validation.workflow);
  const slug = def.slug ?? slugify(def.name);
  const metadata = humanMetadataWrite({
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...input.metadata,
  });
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
          lifecycle: "active",
        })
        .returning();
      assertInsertRow(wf, "workflows");
      const [v] = await tx
        .insert(workflowVersions)
        .values({
          ...versionAuthorColumns(input),
          tenant_id: input.tenant_id,
          workflow_id: wf.id,
          version: 1,
          dag: definitionWithoutDescription(def),
          ...carriedSpecColumns(null),
          ...(input.scope_index ? { scope_index: input.scope_index } : {}),
        })
        .returning();
      assertInsertRow(v, "workflow_versions");
      await tx.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
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
  exec?: Executor,
): Promise<{ workflow: WorkflowView; errors?: never } | { workflow?: never; errors: string[] }> {
  const db = exec ?? getDb();
  const validation = await validateTenantWorkflowDefForSave(input.def, input.tenant_id, db, {
    destinationTier: "tokens",
  });
  if (!validation.ok || !validation.workflow) {
    log.workflow.validation.failed({
      tenant_id: input.tenant_id,
      workflow_id: input.id,
      op: "update",
      error_count: validation.errors.length,
      first_error: validation.errors[0]?.message ?? null,
    });
    return { errors: validation.errors.map((e) => `${e.path}: ${e.message}`) };
  }
  const skillGate = await applySkillSchemaGate(input.tenant_id, validation.workflow, db);
  if (!skillGate.ok) return { errors: skillGate.errors };
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, db);
  if (!storageGate.ok) return { errors: storageGate.errors };
  const def = annotateRuntime(validation.workflow);
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
    const versionRows = (await tx
      .select({
        max_version: sql<number>`coalesce(max(${workflowVersions.version}), 0)`,
      })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, input.tenant_id),
          eq(workflowVersions.workflow_id, wf.id),
        ),
      )) as Array<{ max_version: number }>;
    const next = (versionRows[0]?.max_version ?? 0) + 1;
    const baseSpec = await loadVersionSpec(tx, {
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      version_id: wf.current_version_id,
    });
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        ...versionAuthorColumns(input),
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: next,
        dag: definitionWithoutDescription(def),
        ...carriedSpecColumns(baseSpec),
        ...(input.scope_index ? { scope_index: input.scope_index } : {}),
      })
      .returning();
    assertInsertRow(v, "workflow_versions");
    await tx
      .update(workflows)
      .set({
        name: def.name,
        current_version_id: v.id,
        updated_at: new Date(),
      })
      .where(eq(workflows.id, wf.id));
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

export type UpdateWorkflowMetadataResult =
  | { workflow: WorkflowView; errors?: never }
  | {
      workflow?: never;
      errors: string[];
      conflict?: { workflow_id: string; slug: string; name: string };
    };

export async function updateWorkflowMetadata(
  input: UpdateWorkflowMetadataInput,
  exec?: Executor,
): Promise<UpdateWorkflowMetadataResult> {
  const db = exec ?? getDb();
  const desiredSlug =
    typeof input.slug === "string" && input.slug.length > 0 ? slugify(input.slug) : null;
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
  if (desiredSlug && !/^[a-z0-9][a-z0-9-]*$/.test(desiredSlug)) {
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
        lifecycle?: "active" | "archived";
        updated_at: Date;
      } & CatalogMetadataColumns = {
        updated_at: new Date(),
        ...(metadataProvided ? metadataChange(wf, metadataInput) : null),
      };
      if (desiredSlug && desiredSlug !== wf.slug) patch.slug = desiredSlug;
      if (desiredName && desiredName !== wf.name) patch.name = desiredName;
      if (desiredLifecycle && desiredLifecycle !== wf.lifecycle) {
        patch.lifecycle = desiredLifecycle;
      }
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

export async function listWorkflows(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  exec?: Executor,
): Promise<ListResult<WorkflowView>> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? WORKFLOW_LIST_MAX_LIMIT, WORKFLOW_LIST_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  const tenantConds = buildWorkflowListConds(tenant_id, opts);
  const sortColumn =
    opts.sort === "name"
      ? sql`lower(${workflows.name})`
      : opts.sort === "lifecycle"
        ? workflows.lifecycle
        : opts.sort === "updated_at"
          ? workflows.updated_at
          : workflows.created_at;
  const ordered = opts.order === "asc" ? asc(sortColumn) : desc(sortColumn);

  const withOperatingStates = async (views: WorkflowView[]) => {
    if (!opts.include_operating_status && !opts.operating_status) return views;
    const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    const at = clock.rows[0]?.now;
    if (!at) throw new Error("database clock unavailable");
    const states = await loadWorkflowOperatingStates(
      db,
      tenant_id,
      views,
      opts.operating_access ?? { schedules: false, hooks: false, connectors: false },
      new Date(at),
    );
    return views.map((view) => ({
      ...view,
      operating_status: states.get(view.id)?.operating_status ?? ("unknown" as const),
      authority_environments: states.get(view.id)?.authority_environments ?? {
        dev: null,
        prod: null,
      },
    }));
  };
  const derived = await resolveCatalogFilter(tenant_id, opts, db);
  if (derived || opts.operating_status) {
    const all = await db
      .select({ row: workflows })
      .from(workflows)
      .where(and(...tenantConds))
      .orderBy(...catalogGroupOrder(opts.group_by, workflows.category), ordered, asc(workflows.id));
    const kept = all.filter((r) => !derived || derived.keep(r.row));
    if (opts.operating_status) {
      const views = await withOperatingStates(
        await workflowViewsFromRows(
          tenant_id,
          kept.map((r) => r.row),
          db,
        ),
      );
      const matching = views.filter((view) => view.operating_status === opts.operating_status);
      return { rows: matching.slice(offset, offset + limit), total: matching.length };
    }
    const page = kept.slice(offset, offset + limit).map((r) => r.row);
    return {
      rows: await withOperatingStates(await workflowViewsFromRows(tenant_id, page, db)),
      total: kept.length,
    };
  }

  const rows = await db
    .select({ row: workflows, total: totalOverWindow() })
    .from(workflows)
    .where(and(...tenantConds))
    .orderBy(...catalogGroupOrder(opts.group_by, workflows.category), ordered, asc(workflows.id))
    .limit(limit)
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, () => countWorkflows(db, tenant_id, opts));
  const views = await workflowViewsFromRows(
    tenant_id,
    rows.map((r) => r.row),
    db,
  );
  return { rows: await withOperatingStates(views), total };
}

export interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  lifecycle: "draft" | "active" | "archived";
  current_version: number | null;
  step_count: number;
}

export async function listWorkflowSummaries(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  exec?: Executor,
): Promise<ListResult<WorkflowSummary>> {
  const db = exec ?? getDb();
  if (opts.operating_status) {
    const listed = await listWorkflows(tenant_id, opts, db);
    return {
      rows: listed.rows.map((view) => ({
        id: view.id,
        slug: view.slug,
        name: view.name,
        description: view.description,
        category: view.category,
        lifecycle: view.lifecycle,
        current_version: view.current_version,
        step_count: view.steps.length,
      })),
      total: listed.total,
    };
  }
  const limit = Math.min(opts.limit ?? WORKFLOW_LIST_MAX_LIMIT, WORKFLOW_LIST_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  const tenantConds = buildWorkflowListConds(tenant_id, opts);
  const derived = await resolveCatalogFilter(tenant_id, opts, db);
  const base = db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      category: workflows.category,
      lifecycle: workflows.lifecycle,
      current_version: workflowVersions.version,
      step_count: sql<number>`coalesce(jsonb_array_length(${workflowVersions.dag} -> 'steps'), 0)::int`,
      total: totalOverWindow(),
    })
    .from(workflows)
    .leftJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(and(...tenantConds))
    .orderBy(desc(workflows.created_at));

  const toSummary = (r: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    category: string;
    lifecycle: string;
    current_version: number | null;
    step_count: number;
  }): WorkflowSummary => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    category: r.category,
    lifecycle: r.lifecycle as "draft" | "active" | "archived",
    current_version: r.current_version,
    step_count: Number(r.step_count ?? 0),
  });

  if (derived) {
    const kept = (await base).filter((r) => derived.keep(r));
    return {
      rows: kept.slice(offset, offset + limit).map(toSummary),
      total: kept.length,
    };
  }

  const rows = await base.limit(limit).offset(offset);
  const total = await resolveWindowTotal(rows, offset, () => countWorkflows(db, tenant_id, opts));
  return { rows: rows.map(toSummary), total };
}

export async function getWorkflow(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<WorkflowView | null> {
  const db = exec ?? getDb();
  return loadWorkflowView(tenant_id, id, db);
}

export async function getWorkflowBySlug(
  tenant_id: string,
  slug: string,
  exec?: Executor,
): Promise<WorkflowView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.slug, slug),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  const id = rows[0]?.id;
  if (!id) return null;
  return loadWorkflowView(tenant_id, id, db);
}

export async function deleteWorkflow(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
  actor_type?: AuditActorType,
): Promise<boolean> {
  const db = exec ?? getDb();
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
