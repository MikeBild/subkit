// Workflow CRUD + version snapshots. Every upsert writes a new row in
// `workflow_versions` and points `workflows.current_version_id` at it.
// Restore is additive: it duplicates an old version's dag as a new version
// with N+1, never overwriting history.

import { and, asc, desc, eq, isNull, like, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { skills as skillsTable, workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { validateOutputSchemaSuperset, validateWorkflowDef } from "./validator.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface WorkflowView {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  lifecycle: "draft" | "active" | "archived";
  current_version_id: string | null;
  current_version: number | null;
  created_at: Date;
  updated_at: Date;
  definition: WorkflowDef;
  steps: WorkflowDef["steps"];
}

export interface VersionView {
  id: string;
  workflow_id: string;
  version: number;
  dag: WorkflowDef;
  note: string | null;
  created_at: Date;
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

/**
 * Apply the discriminated `trigger` block from a workflow def to its
 * reverse-bound rows in `webhooks_inbound` / `workflows_schedules`.
 * Idempotent on `(tenant_id, workflow_id)` — repeated calls with the
 * same trigger are no-ops.
 *
 * Lifecycle contract:
 *
 *   * `kind: "request"` (or no trigger) → tear down any prior
 *     webhook + schedule binding the workflow had. This is what
 *     happens when an operator removes a trigger from an existing
 *     workflow: the next save unbinds the public ingress.
 *   * `kind: "webhook"` → upsert the inbound row, tear down any
 *     stale schedule.
 *   * `kind: "schedule"` → upsert the schedule row, tear down any
 *     stale inbound binding.
 *
 * The two-arm tear-down keeps a workflow from carrying both
 * bindings simultaneously when its trigger flips between the
 * variants — without it, a `webhook → schedule` edit would leave
 * the public webhook URL live.
 */
async function applyTriggerBindings(
  exec: Executor,
  tenant_id: string,
  workflow_id: string,
  workflow_slug: string,
  def: WorkflowDef,
  actor_id: string | null,
): Promise<void> {
  const trigger = def.trigger ?? { kind: "request" as const };
  if (trigger.kind === "webhook") {
    await inboundService.bindFromWorkflow(
      {
        tenant_id,
        workflow_id,
        workflow_slug,
        trigger,
        actor_id,
      },
      exec,
    );
    await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id);
    return;
  }
  if (trigger.kind === "schedule") {
    await scheduleRepo.bindFromWorkflow(exec, {
      tenant_id,
      workflow_id,
      trigger,
      actor_id,
    });
    await inboundService.unbindFromWorkflow(tenant_id, workflow_id, actor_id, exec);
    return;
  }
  // "request" — make sure neither binding lingers.
  await inboundService.unbindFromWorkflow(tenant_id, workflow_id, actor_id, exec);
  await scheduleRepo.unbindFromWorkflow(exec, tenant_id, workflow_id, actor_id);
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
  const wf = rows[0];
  if (!wf) return null;
  let version: number | null = null;
  let def: WorkflowDef = { name: wf.name, steps: [] } as WorkflowDef;
  if (wf.current_version_id) {
    const vRows = await exec
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.id, wf.current_version_id),
        ),
      )
      .limit(1);
    const v = vRows[0];
    if (v) {
      version = v.version;
      def = WorkflowDefSchema.parse(v.dag);
    }
  }
  return {
    id: wf.id,
    tenant_id: wf.tenant_id,
    slug: wf.slug,
    name: wf.name,
    lifecycle: wf.lifecycle as "draft" | "active" | "archived",
    current_version_id: wf.current_version_id,
    current_version: version,
    created_at: wf.created_at,
    updated_at: wf.updated_at,
    definition: def,
    steps: def.steps,
  };
}

export interface CreateWorkflowInput {
  tenant_id: string;
  def: unknown;
  actor_id: string | null;
  /**
   * Optional `step_id → scope_at_step` map captured from the most
   * recent dry_run / run before commit. When supplied, persisted on
   * `workflow_versions.scope_index` so a follow-up authoring session
   * can populate `inspect_workflow` / `suggest_jsonata_paths` without
   * re-running the workflow.
   */
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
  const validation = validateWorkflowDef(input.def);
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
  const def = annotateRuntime(validation.workflow);
  const slug = def.slug ?? slugify(def.name);
  const result = await db.transaction(async (tx) => {
    const [wf] = await tx
      .insert(workflows)
      .values({
        tenant_id: input.tenant_id,
        slug,
        name: def.name,
        lifecycle: "active",
      })
      .returning();
    assertInsertRow(wf, "workflows");
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: 1,
        dag: def,
        ...(input.scope_index ? { scope_index: input.scope_index } : {}),
      })
      .returning();
    assertInsertRow(v, "workflow_versions");
    await tx.update(workflows).set({ current_version_id: v.id }).where(eq(workflows.id, wf.id));
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.WORKFLOW_CREATED,
        resource_type: "workflow",
        resource_id: wf.id,
        result: "success",
        metadata: { slug, version: 1 },
      },
      tx,
    );
    await applyTriggerBindings(tx, input.tenant_id, wf.id, slug, def, input.actor_id);
    return wf.id;
  });
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

export interface UpdateWorkflowInput {
  tenant_id: string;
  id: string;
  def: unknown;
  actor_id: string | null;
  /** See `CreateWorkflowInput.scope_index`. */
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
  const validation = validateWorkflowDef(input.def);
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
  const def = annotateRuntime(validation.workflow);
  const updated = await db.transaction(async (tx) => {
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
      .limit(1);
    const wf = wfRows[0];
    if (!wf) return null;
    // determine next version
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
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: next,
        dag: def,
        ...(input.scope_index ? { scope_index: input.scope_index } : {}),
      })
      .returning();
    assertInsertRow(v, "workflow_versions");
    await tx
      .update(workflows)
      .set({ name: def.name, current_version_id: v.id, updated_at: new Date() })
      .where(eq(workflows.id, wf.id));
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.WORKFLOW_UPDATED,
        resource_type: "workflow",
        resource_id: wf.id,
        result: "success",
        metadata: { version: next },
      },
      tx,
    );
    log.workflow.committed({
      workflow_id: wf.id,
      tenant_id: input.tenant_id,
      slug: wf.slug,
      version: next,
      step_count: def.steps.length,
      actor_id: input.actor_id,
    });
    await applyTriggerBindings(tx, input.tenant_id, wf.id, wf.slug, def, input.actor_id);
    return wf.id;
  });
  if (!updated) return { errors: ["workflow not found"] };
  const view = await loadWorkflowView(input.tenant_id, updated, db);
  if (!view) return { errors: ["workflow not found after update"] };
  return { workflow: view };
}

export interface UpdateWorkflowMetadataInput {
  tenant_id: string;
  id: string;
  /**
   * New slug. Lowercase, hyphenated. Must be unique across live
   * (non-deleted) workflows in the tenant. Reject when omitted AND
   * every other patch field is also omitted (no-op).
   */
  slug?: string;
  /** New display name. Independently optional. */
  name?: string;
  /** New lifecycle state ("active" / "archived"). "draft" cannot be set explicitly. */
  lifecycle?: "active" | "archived";
  actor_id: string | null;
}

export type UpdateWorkflowMetadataResult =
  | { workflow: WorkflowView; errors?: never }
  | {
      workflow?: never;
      errors: string[];
      /** When the failure is a slug collision, surfaces the colliding workflow id. */
      conflict?: { workflow_id: string; slug: string; name: string };
    };

/**
 * Patch a workflow's metadata (slug, display name, lifecycle) in place.
 * Does NOT change the dag, version history, or workflow id — those
 * mutations go through `updateWorkflow` which writes a new
 * workflow_versions row. This op is the structural twin of the
 * reference's HTTP `POST /tools/:toolId/rename` (rename) plus the
 * existing lifecycle endpoints, collapsed into one generic patch:
 * the LLM tool surface chooses what subset of fields to send.
 *
 * Slug uniqueness is enforced by the partial unique index
 * `workflows_tenant_slug_active_key` (tenant_id, slug WHERE
 * deleted_at IS NULL). Postgres raises 23505 on collision; we map it
 * to a structured `slug_conflict_with_live_workflow` error with the
 * conflicting row's id + name so the caller can decide.
 *
 * Audit shape: `WORKFLOW_UPDATED` with metadata
 * `{ kind: "metadata", from: { slug, name, lifecycle }, to: {...} }`.
 * No new audit-action enum entry — semantically still a workflow
 * update event. The discriminator lets dashboards split rename / def
 * / lifecycle without losing the "workflow.updated" topic.
 */
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
  if (!desiredSlug && !desiredName && !desiredLifecycle) {
    return {
      errors: ["updateWorkflowMetadata requires at least one of slug, name, or lifecycle"],
    };
  }
  if (desiredSlug && !/^[a-z0-9][a-z0-9-]*$/.test(desiredSlug)) {
    return { errors: ["slug must be lowercase alphanumeric with hyphens"] };
  }
  try {
    const result = await db.transaction(async (tx) => {
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
        .limit(1);
      const wf = wfRows[0];
      if (!wf) return null;
      // Slug-conflict pre-check so we can surface the conflicting row's
      // id + name. The partial unique index will catch concurrent inserts
      // anyway and produce a 23505 — caught below.
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
      } = {
        updated_at: new Date(),
      };
      if (desiredSlug && desiredSlug !== wf.slug) patch.slug = desiredSlug;
      if (desiredName && desiredName !== wf.name) patch.name = desiredName;
      if (desiredLifecycle && desiredLifecycle !== wf.lifecycle) {
        patch.lifecycle = desiredLifecycle;
      }
      // Nothing actually changed — no-op patch, no audit.
      if (patch.slug === undefined && patch.name === undefined && patch.lifecycle === undefined) {
        return { id: wf.id, noop: true as const };
      }
      await tx.update(workflows).set(patch).where(eq(workflows.id, wf.id));
      await auditAwait(
        {
          tenant_id: input.tenant_id,
          actor_type: input.actor_id ? "user" : "system",
          actor_id: input.actor_id,
          action: AuditAction.WORKFLOW_UPDATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          metadata: {
            kind: "metadata",
            from: { slug: wf.slug, name: wf.name, lifecycle: wf.lifecycle },
            to: {
              slug: patch.slug ?? wf.slug,
              name: patch.name ?? wf.name,
              lifecycle: patch.lifecycle ?? wf.lifecycle,
            },
          },
        },
        tx,
      );
      // Metadata-only update — no new version row, no step count.
      // Reuse the workflow.committed log line so dashboards see the
      // event without inventing a separate "metadata-only" topic.
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
    const msg = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    const code = (err as { code?: string }).code ?? cause?.code;
    const looksLikeSlugConflict =
      code === "23505" ||
      msg.includes("23505") ||
      msg.toLowerCase().includes("duplicate key") ||
      msg.includes("workflows_tenant_slug");
    if (looksLikeSlugConflict && desiredSlug) {
      const conflictRows = await db
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
      const existing = conflictRows[0];
      return {
        errors: [
          existing
            ? `slug "${desiredSlug}" already belongs to workflow "${existing.name}" (id=${existing.id})`
            : `slug "${desiredSlug}" already exists for this tenant`,
        ],
        ...(existing
          ? { conflict: { workflow_id: existing.id, slug: existing.slug, name: existing.name } }
          : {}),
      };
    }
    return { errors: [msg] };
  }
}

export interface ListWorkflowsOptions {
  limit?: number;
  offset?: number;
  status?: "draft" | "active" | "archived";
  name_contains?: string;
}

export async function listWorkflows(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  exec?: Executor,
): Promise<WorkflowView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const tenantConds = [eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)];
  if (opts.status) tenantConds.push(eq(workflows.lifecycle, opts.status));
  if (opts.name_contains) tenantConds.push(like(workflows.name, `%${opts.name_contains}%`));
  const rows = await db
    .select()
    .from(workflows)
    .where(and(...tenantConds))
    .orderBy(desc(workflows.created_at))
    .limit(limit)
    .offset(opts.offset ?? 0);
  const out: WorkflowView[] = [];
  for (const wf of rows) {
    const v = await loadWorkflowView(tenant_id, wf.id, db);
    if (v) out.push(v);
  }
  return out;
}

export async function getWorkflow(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<WorkflowView | null> {
  const db = exec ?? getDb();
  return loadWorkflowView(tenant_id, id, db);
}

/**
 * Resolve a workflow by slug within a tenant. Returns null if no
 * matching active row exists. Used by the chat dispatcher's
 * `/subkit run <slug>` path so users don't have to know UUIDs.
 */
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
    // Tear down both reverse-bound rows regardless of the workflow's
    // last trigger kind. A schedule binding still belongs to a
    // soft-deleted workflow until we remove it; ditto the inbound
    // public ingress.
    await inboundService.unbindFromWorkflow(tenant_id, row.id, actor_id, tx);
    await scheduleRepo.unbindFromWorkflow(tx, tenant_id, row.id, actor_id);
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.WORKFLOW_DELETED,
        resource_type: "workflow",
        resource_id: row.id,
        result: "success",
      },
      tx,
    );
    return true;
  });
}

export async function listWorkflowVersions(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<VersionView[]> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)))
    .orderBy(asc(workflowVersions.version));
  return rows.map((r) => ({
    id: r.id,
    workflow_id: r.workflow_id,
    version: r.version,
    dag: WorkflowDefSchema.parse(r.dag),
    note: r.note,
    created_at: r.created_at,
  }));
}

export async function restoreWorkflowVersion(
  tenant_id: string,
  id: string,
  version: number,
  actor_id: string | null,
  exec?: Executor,
): Promise<WorkflowView | null> {
  const db = exec ?? getDb();
  const updatedId = await db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, tenant_id),
          eq(workflowVersions.workflow_id, id),
          eq(workflowVersions.version, version),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) return null;
    const restoreRows = (await tx
      .select({
        max_version: sql<number>`coalesce(max(${workflowVersions.version}), 0)`,
      })
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, id)),
      )) as Array<{ max_version: number }>;
    const next = (restoreRows[0]?.max_version ?? 0) + 1;
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id,
        workflow_id: id,
        version: next,
        dag: target.dag,
        note: `restored from v${version}`,
      })
      .returning();
    assertInsertRow(v, "restore");
    await tx
      .update(workflows)
      .set({ current_version_id: v.id, updated_at: new Date() })
      .where(eq(workflows.id, id));
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.WORKFLOW_VERSION_RESTORED,
        resource_type: "workflow",
        resource_id: id,
        result: "success",
        metadata: { restored_from: version, new_version: next },
      },
      tx,
    );
    log.workflow.restored({
      workflow_id: id,
      tenant_id,
      restored_from: version,
      new_version: next,
      actor_id,
    });
    // Re-apply trigger bindings from the restored definition. A
    // workflow that was, for example, scheduled at v3 but rotated to a
    // request-only v4 must have its schedule torn down on restore-to-
    // v3 and re-bound; otherwise the public surface drifts from the
    // committed dag.
    const restoredDef = WorkflowDefSchema.parse(target.dag);
    const wfRows = await tx
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)))
      .limit(1);
    const wfSlug = wfRows[0]?.slug ?? id;
    await applyTriggerBindings(tx, tenant_id, id, wfSlug, restoredDef, actor_id);
    return id;
  });
  if (!updatedId) return null;
  return loadWorkflowView(tenant_id, updatedId, db);
}

/**
 * Skill-schema gate. When the workflow declares `derived_from_skill_id`,
 * load the referenced skill and require the workflow's `output_schema`
 * to structurally cover the skill's. The proof-before-save invariant
 * means a recipe-cloned workflow cannot silently narrow its public
 * contract away from the skill's promise. Returns `{ok:true}` when
 * either the skill is missing (treated as if no contract was promised)
 * or the gate passes — typed errors only on actual narrowing.
 */
async function applySkillSchemaGate(
  tenant_id: string,
  def: WorkflowDef,
  exec: Executor,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const skillId = (def as { derived_from_skill_id?: string | null }).derived_from_skill_id;
  if (!skillId) return { ok: true };
  const rows = await exec
    .select({ output_schema: skillsTable.output_schema })
    .from(skillsTable)
    .where(and(eq(skillsTable.tenant_id, tenant_id), eq(skillsTable.slug, skillId)))
    .limit(1);
  const skillSchema = rows[0]?.output_schema ?? null;
  const result = validateOutputSchemaSuperset(skillSchema, def.output_schema ?? null);
  if (result.ok) return { ok: true };
  log.workflow.validation.failed({
    tenant_id,
    op: "skill_gate",
    error_count: result.missing_fields.length,
    first_error: `output_schema missing required fields from skill ${skillId}: ${result.missing_fields.join(", ")}`,
  });
  return {
    ok: false,
    errors: [
      `skill_schema_gate: workflow.output_schema is missing fields required by derived_from_skill_id=${skillId}: ${result.missing_fields.join(", ")}`,
    ],
  };
}
