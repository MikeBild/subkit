// Workflow CRUD + version snapshots. Every upsert writes a new row in
// `workflow_versions` and points `workflows.current_version_id` at it.
// Restore is additive: it duplicates an old version's dag as a new version
// with N+1, never overwriting history.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Executor, getDb } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { type WorkflowLifecyclePayload, WorkflowLifecyclePayloadSchema } from "../pubsub/types.ts";
import * as scheduleRepo from "../scheduler/repo.ts";
import * as inboundService from "../webhooks/inbound/service.ts";
import {
  buildWorkflowListConds,
  countWorkflows,
  type ListWorkflowsOptions,
  resolveCatalogFilter,
  WORKFLOW_LIST_MAX_LIMIT,
} from "./catalog-view.ts";
import { applySkillSchemaGate, applyStorageBindingGate } from "./commit-gates.ts";
import { annotateRuntime } from "./runtime-annotation.ts";
import { slugConflictResult } from "./slug-conflict.ts";
import { applyTriggerBindings, triggerOf } from "./trigger-bindings.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";
import { isUnchangedFromCurrentVersion } from "./version-dedup.ts";

/**
 * Emit a `workflow.lifecycle` outbox event after Zod-validating the
 * payload. Every state-changing entry point in this
 * file flows through this helper so the channel can't drift into
 * untyped object literals over time. The schema lives in
 * `pubsub/types.ts` so subscribers (today: the MCP forwarder) can
 * share a single source of truth. Exported for the definition-only
 * rotate in `version-rotate.ts`.
 */
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
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  /** First-class workflow description (workflows.description column). Null
   *  when never set — readers fall back to the DAG description, then name. */
  description: string | null;
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
    description: wf.description ?? null,
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
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, db);
  if (!storageGate.ok) return { errors: storageGate.errors };
  const def = annotateRuntime(validation.workflow);
  const slug = def.slug ?? slugify(def.name);
  let result: string;
  try {
    result = await db.transaction(async (tx) => {
      const [wf] = await tx
        .insert(workflows)
        .values({
          tenant_id: input.tenant_id,
          slug,
          name: def.name,
          // Seed the top-level description column from the DAG so a freshly
          // built workflow's `wf_<slug>` tool carries the authored description
          // immediately — without forcing a follow-up update_workflow /
          // edit_workflow_patch. The column is the canonical source the catalog
          // prefers (column → DAG → name); leaving it NULL here was why every
          // newly committed workflow showed a "missing" top-level description.
          ...(def.description ? { description: def.description } : {}),
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
      await emitWorkflowLifecycle(tx, {
        tenant_id: input.tenant_id,
        type: "workflow.created",
        payload: { workflow_id: wf.id, slug, version: 1, actor_id: input.actor_id ?? null },
      });
      await applyTriggerBindings(tx, input.tenant_id, wf.id, slug, def, input.actor_id);
      return wf.id;
    });
  } catch (err) {
    // Duplicate active slug → clean conflict result instead of an unhandled
    // 500. Any non-conflict failure rethrows unchanged.
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
  const storageGate = await applyStorageBindingGate(input.tenant_id, validation.workflow, db);
  if (!storageGate.ok) return { errors: storageGate.errors };
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
    // Idempotency: an unchanged def must not rotate the version (that
    // churns history and unbinds schedules). See `version-dedup.ts`.
    const dedup = await isUnchangedFromCurrentVersion({
      tx,
      tenant_id: input.tenant_id,
      workflow_id: wf.id,
      workflow_slug: wf.slug,
      current_version_id: wf.current_version_id,
      def,
      scope_index: input.scope_index,
    });
    if (dedup.unchanged) {
      return wf.id;
    }
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
      // Keep the top-level description column in sync with the committed DAG
      // (def.description is authoritative on the full-def path). Authors who
      // edit the description inside build_workflow / save_workflow_draft get
      // it reflected on the `wf_<slug>` tool without a separate metadata call;
      // removing it from the def clears the column too.
      .set({
        name: def.name,
        description: def.description ?? null,
        current_version_id: v.id,
        updated_at: new Date(),
      })
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
    // Reconcile trigger bindings ONLY when the trigger block actually changed.
    // An unconditional reconcile here unbinds out-of-band schedules (those
    // bound via create_schedule, carrying a workflow input the inline trigger
    // cannot express) on any step-only edit — the PUT-unbinds-schedules trap.
    // `!dedup.current_def` (no prior version) → bind. Removing/changing an
    // inline trigger DOES change the block → still reconciles (so an
    // intentional unbind/rebind still happens). Mirrors the byte-equality
    // invariant the migration rotate path already enforces.
    const triggerChanged =
      !dedup.current_def ||
      JSON.stringify(triggerOf(def)) !== JSON.stringify(triggerOf(dedup.current_def));
    if (triggerChanged) {
      await applyTriggerBindings(tx, input.tenant_id, wf.id, wf.slug, def, input.actor_id);
    }
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
  /**
   * New workflow description (workflows.description column). Independently
   * optional. A non-empty string sets it; an empty/whitespace string clears
   * it (stored as NULL). Omit to leave the description unchanged. Metadata
   * patch — never rolls a new version.
   */
  description?: string | null;
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
  // Description is the only patch field where an empty value is meaningful
  // (clear → NULL), so we track "provided" separately from the trimmed
  // value. `undefined` means "leave unchanged"; any string (incl. "") means
  // "set", with empty/whitespace normalised to NULL.
  const descriptionProvided = typeof input.description === "string";
  const desiredDescription = descriptionProvided
    ? (input.description as string).trim() || null
    : null;
  if (!desiredSlug && !desiredName && !desiredLifecycle && !descriptionProvided) {
    return {
      errors: [
        "updateWorkflowMetadata requires at least one of slug, name, lifecycle, or description",
      ],
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
        description?: string | null;
        lifecycle?: "active" | "archived";
        updated_at: Date;
      } = {
        updated_at: new Date(),
      };
      if (desiredSlug && desiredSlug !== wf.slug) patch.slug = desiredSlug;
      if (desiredName && desiredName !== wf.name) patch.name = desiredName;
      // Only patch description when it was provided AND differs from the
      // current value (NULL-normalised both sides) — so a redundant set is a
      // no-op rather than a spurious audit row.
      if (descriptionProvided && desiredDescription !== (wf.description ?? null)) {
        patch.description = desiredDescription;
      }
      if (desiredLifecycle && desiredLifecycle !== wf.lifecycle) {
        patch.lifecycle = desiredLifecycle;
      }
      // Nothing actually changed — no-op patch, no audit.
      if (
        patch.slug === undefined &&
        patch.name === undefined &&
        patch.description === undefined &&
        patch.lifecycle === undefined
      ) {
        return { id: wf.id, noop: true as const };
      }
      await tx.update(workflows).set(patch).where(eq(workflows.id, wf.id));
      // Archiving tears down trigger bindings exactly like delete does —
      // an archived workflow must not keep live-looking schedule/inbound
      // rows that only a reconciler filter stops from firing. Unarchiving
      // does not restore them; re-saving the trigger re-binds.
      if (patch.lifecycle === "archived") {
        await inboundService.unbindFromWorkflow(input.tenant_id, wf.id, input.actor_id ?? null, tx);
        await scheduleRepo.unbindFromWorkflow(tx, input.tenant_id, wf.id, input.actor_id ?? null);
      }
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
            from: {
              slug: wf.slug,
              name: wf.name,
              description: wf.description ?? null,
              lifecycle: wf.lifecycle,
            },
            to: {
              slug: patch.slug ?? wf.slug,
              name: patch.name ?? wf.name,
              description:
                patch.description === undefined ? (wf.description ?? null) : patch.description,
              lifecycle: patch.lifecycle ?? wf.lifecycle,
            },
          },
        },
        tx,
      );
      // Emit on the same channel as definition-level updates — a rename
      // / lifecycle flip changes what `readResource("workflow://<id>")`
      // would return, so MCP subscribers must see it.
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
    if (desiredSlug) {
      const conflict = await slugConflictResult(err, db, input.tenant_id, desiredSlug);
      if (conflict) return conflict;
    }
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
}

// The list scaffolding (`ListWorkflowsOptions`, `buildWorkflowListConds`,
// `WORKFLOW_LIST_MAX_LIMIT`, `countWorkflows`) and the derived catalog view
// live in `catalog-view.ts` — this file sits against the 1000-LOC audit
// invariant. Both are re-exported by the subsystem barrel (`index.ts`).
export async function listWorkflows(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  exec?: Executor,
): Promise<ListResult<WorkflowView>> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? WORKFLOW_LIST_MAX_LIMIT, WORKFLOW_LIST_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  const tenantConds = buildWorkflowListConds(tenant_id, opts);

  // Derived filters cannot be expressed in SQL, so they run over the matching
  // row set before the page is cut — which also means only the page's views
  // get loaded, not every match.
  const derived = await resolveCatalogFilter(tenant_id, opts, db);
  if (derived) {
    const all = await db
      .select({ row: workflows })
      .from(workflows)
      .where(and(...tenantConds))
      .orderBy(desc(workflows.created_at));
    const kept = all.filter((r) => derived.keep(r.row));
    const out: WorkflowView[] = [];
    for (const r of kept.slice(offset, offset + limit)) {
      const v = await loadWorkflowView(tenant_id, r.row.id, db);
      if (v) out.push(v);
    }
    return { rows: out, total: kept.length };
  }

  const rows = await db
    .select({ row: workflows, total: totalOverWindow() })
    .from(workflows)
    .where(and(...tenantConds))
    .orderBy(desc(workflows.created_at))
    .limit(limit)
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, () => countWorkflows(db, tenant_id, opts));
  const out: WorkflowView[] = [];
  for (const r of rows) {
    const v = await loadWorkflowView(tenant_id, r.row.id, db);
    if (v) out.push(v);
  }
  return { rows: out, total };
}

export interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  lifecycle: "draft" | "active" | "archived";
  current_version: number | null;
  step_count: number;
}

/**
 * Lightweight list path for callers that only need the metadata
 * displayed in a picker, the MCP `resources/list` view, or a
 * dashboard summary — no `WorkflowDefSchema.parse` per row, no full
 * `dag` payload over the wire. Uses Postgres' `jsonb_array_length`
 * to count steps server-side. Mirrors `listWorkflows` filtering
 * surface (status, name_contains, limit, offset) and ordering
 * (newest first).
 */
export async function listWorkflowSummaries(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  exec?: Executor,
): Promise<ListResult<WorkflowSummary>> {
  const db = exec ?? getDb();
  const limit = Math.min(opts.limit ?? WORKFLOW_LIST_MAX_LIMIT, WORKFLOW_LIST_MAX_LIMIT);
  const offset = opts.offset ?? 0;
  const tenantConds = buildWorkflowListConds(tenant_id, opts);
  const derived = await resolveCatalogFilter(tenant_id, opts, db);
  const base = db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
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
    lifecycle: string;
    current_version: number | null;
    step_count: number;
  }): WorkflowSummary => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    lifecycle: r.lifecycle as "draft" | "active" | "archived",
    current_version: r.current_version,
    step_count: Number(r.step_count ?? 0),
  });

  // Same reason as `listWorkflows`: a derived predicate has to see the whole
  // match set before the page is cut, or `total` would count non-matches.
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
    await emitWorkflowLifecycle(tx, {
      tenant_id,
      type: "workflow.deleted",
      payload: { workflow_id: row.id, slug: row.slug, actor_id: actor_id ?? null },
    });
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
    // Restore makes the target version current, so the top-level description
    // column must track that version's DAG description (mirrors the
    // create/update full-def paths). dag is jsonb-typed `unknown`; read its
    // description defensively.
    const restoredDescription =
      target.dag && typeof target.dag === "object" && !Array.isArray(target.dag)
        ? ((target.dag as { description?: unknown }).description ?? null)
        : null;
    await tx
      .update(workflows)
      .set({
        current_version_id: v.id,
        description: typeof restoredDescription === "string" ? restoredDescription : null,
        updated_at: new Date(),
      })
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
    // A version restore replaces what `readResource("workflow://<id>")`
    // returns; MCP subscribers must be notified.
    await emitWorkflowLifecycle(tx, {
      tenant_id,
      type: "workflow.version_restored",
      payload: {
        workflow_id: id,
        restored_from: version,
        new_version: next,
        actor_id: actor_id ?? null,
      },
    });
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
