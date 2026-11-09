import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import {
  catalogGroupOrder,
  type ListResult,
  resolveWindowTotal,
  totalOverWindow,
} from "../db/list-result.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import {
  buildWorkflowListConds,
  countWorkflows,
  type ListWorkflowsOptions,
  resolveCatalogFilter,
  WORKFLOW_LIST_MAX_LIMIT,
} from "./catalog-view.ts";
import { loadWorkflowOperatingStates } from "./operating-status.ts";
import { loadWorkflowView, workflowViewsFromRows } from "./read-projections.ts";
import type { WorkflowView } from "./view.ts";

export async function listWorkflows(
  tenant_id: string,
  opts: ListWorkflowsOptions = {},
  db: Executor,
): Promise<ListResult<WorkflowView>> {
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
  db: Executor,
): Promise<ListResult<WorkflowSummary>> {
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
  db: Executor,
): Promise<WorkflowView | null> {
  return loadWorkflowView(tenant_id, id, db);
}

export async function getWorkflowBySlug(
  tenant_id: string,
  slug: string,
  db: Executor,
): Promise<WorkflowView | null> {
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
