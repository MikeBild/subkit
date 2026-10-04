import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { deriveCategories, UNCATEGORIZED } from "./categorize.ts";
import { workflowIdsUsingConnector } from "./connector-refs.ts";

export interface CatalogFilterOptions {
  category?: string;
  connector?: string;
}

export interface ListWorkflowsOptions extends CatalogFilterOptions {
  limit?: number;
  offset?: number;
  status?: "draft" | "active" | "archived";
  name_contains?: string;
  q?: string;
  sort?: "name" | "lifecycle" | "created_at" | "updated_at";
  order?: "asc" | "desc";
}

export function buildWorkflowListConds(tenant_id: string, opts: ListWorkflowsOptions) {
  const conds = [eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)];
  if (opts.status) conds.push(eq(workflows.lifecycle, opts.status));
  if (opts.name_contains) conds.push(ilike(workflows.name, `%${opts.name_contains}%`));
  if (opts.q) {
    const needle = `%${opts.q}%`;
    const search = or(
      ilike(workflows.name, needle),
      ilike(workflows.slug, needle),
      ilike(workflows.description, needle),
    );
    if (search) conds.push(search);
  }
  return conds;
}

export const WORKFLOW_LIST_MAX_LIMIT = 1000;

export async function countWorkflows(
  db: Executor,
  tenant_id: string,
  opts: ListWorkflowsOptions,
): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(workflows)
    .where(and(...buildWorkflowListConds(tenant_id, opts)));
  return Number(row?.c ?? 0);
}

export async function loadCategoryIndex(
  tenant_id: string,
  exec?: Executor,
): Promise<Map<string, string>> {
  const db = exec ?? getDb();
  const rows = await db
    .select({ slug: workflows.slug })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)));
  return deriveCategories(rows.map((r) => r.slug));
}

export async function buildNamingGroundingBlock(
  tenant_id: string,
  exec?: Executor,
): Promise<string | null> {
  const index = await loadCategoryIndex(tenant_id, exec);
  const counts = new Map<string, number>();
  for (const category of index.values()) {
    if (category === UNCATEGORIZED) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const families = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([category, count]) => `${category} (${count})`)
    .join(", ");
  return [
    "WORKFLOW NAMING — join an existing family when one fits:",
    `Existing catalog families: ${families}.`,
    "The catalog groups workflows by the leading dash-separated segments of their slug, so the slug decides which block a workflow lands in.",
    "When the workflow you are authoring belongs to one of the families above, give it a `slug` carrying that family prefix (e.g. a new Notion reader → `notion-<what-it-does>`).",
    "Keep `name` a clean human title — `slug` is a separate field, so the family prefix never has to show up in the display name.",
    "When it genuinely belongs to no existing family, name it plainly. Do NOT invent a prefix to force a match, and do NOT rename existing workflows.",
  ].join("\n");
}

export interface CatalogFilter {
  keep(row: { id: string; slug: string }): boolean;
}

export async function resolveCatalogFilter(
  tenant_id: string,
  opts: CatalogFilterOptions,
  exec?: Executor,
): Promise<CatalogFilter | null> {
  const db = exec ?? getDb();
  const wantCategory = opts.category?.trim();
  const wantConnector = opts.connector?.trim();
  if (!wantCategory && !wantConnector) return null;

  const categories = wantCategory ? await loadCategoryIndex(tenant_id, db) : null;
  const connectorMatches = wantConnector
    ? await workflowIdsUsingConnector(tenant_id, wantConnector, db)
    : null;

  return {
    keep(row) {
      if (categories && (categories.get(row.slug) ?? UNCATEGORIZED) !== wantCategory) return false;
      if (connectorMatches && !connectorMatches.has(row.id)) return false;
      return true;
    },
  };
}
