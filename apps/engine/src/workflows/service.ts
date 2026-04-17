// Workflow CRUD + version snapshots. Every upsert writes a new row in
// `workflow_versions` and points `workflows.current_version_id` at it.
// Restore is additive: it duplicates an old version's dag as a new version
// with N+1, never overwriting history.

import { and, asc, desc, eq, isNull, like, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { log } from "../logging/logger.ts";
import { type WorkflowDef, WorkflowDefSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

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
      .where(eq(workflowVersions.id, wf.current_version_id))
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
    steps: def.steps,
  };
}

export interface CreateWorkflowInput {
  tenant_id: string;
  def: unknown;
  actor_id: string | null;
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
  const def = validation.workflow;
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
    if (!wf) throw new Error("workflows insert returned no row");
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: 1,
        dag: def,
      })
      .returning();
    if (!v) throw new Error("workflow_versions insert returned no row");
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
  const def = validation.workflow;
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
      .where(eq(workflowVersions.workflow_id, wf.id))) as Array<{ max_version: number }>;
    const next = (versionRows[0]?.max_version ?? 0) + 1;
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        tenant_id: input.tenant_id,
        workflow_id: wf.id,
        version: next,
        dag: def,
      })
      .returning();
    if (!v) throw new Error("workflow_versions insert returned no row");
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
    return wf.id;
  });
  if (!updated) return { errors: ["workflow not found"] };
  const view = await loadWorkflowView(input.tenant_id, updated, db);
  if (!view) return { errors: ["workflow not found after update"] };
  return { workflow: view };
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
  const conds = [eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)];
  if (opts.status) conds.push(eq(workflows.lifecycle, opts.status));
  if (opts.name_contains) conds.push(like(workflows.name, `%${opts.name_contains}%`));
  const rows = await db
    .select()
    .from(workflows)
    .where(and(...conds))
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
      .where(eq(workflowVersions.workflow_id, id))) as Array<{ max_version: number }>;
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
    if (!v) throw new Error("restore insert returned no row");
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
    return id;
  });
  if (!updatedId) return null;
  return loadWorkflowView(tenant_id, updatedId, db);
}
