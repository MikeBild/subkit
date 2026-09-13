// The derived view every workflow list surface shares: the category index used
// for display, and the `category` / `connector` predicates used for filtering.
//
// Neither predicate can be pushed into the SQL WHERE clause:
//   - a category is a function of the WHOLE slug corpus, not of one row
//     (`categorize.ts`), so it does not exist until the catalog is known;
//   - "uses connector X" spans two binding forms, one of which lives inside
//     url strings (`connector-refs.ts`).
// Both are therefore resolved once per request and applied to the row set
// BEFORE the page is cut, so `total` counts matches rather than the unfiltered
// catalog. Workflows are a bounded business catalog (O(10²)) — that is what
// makes this affordable, and it is the same assumption behind
// `WORKFLOW_LIST_MAX_LIMIT`.

import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { type Executor, getDb } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";
import { deriveCategories, UNCATEGORIZED } from "./categorize.ts";
import { workflowIdsUsingConnector } from "./connector-refs.ts";

export interface CatalogFilterOptions {
  /** Derived catalog block (see `categorize.ts`) — applied after load. */
  category?: string;
  /** Connector id or slug the workflow must reference (`connector-refs.ts`). */
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

/**
 * Build the WHERE conditions shared by `listWorkflows` and
 * `listWorkflowSummaries`. Centralising the predicate avoids drift the next
 * time the list surface gains a filter (e.g. an `owner_id` knob). Note that
 * the derived filters above deliberately do NOT live here — they cannot be
 * expressed in SQL at all.
 */
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

/**
 * Workflows are a bounded business catalog (O(10²)), not telemetry — the
 * default page is the safety bound itself so enumeration surfaces (fast
 * path, conversation tools, MCP resources) see the complete set unless a
 * caller explicitly pages.
 */
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

/**
 * Category per slug for the tenant's whole catalog.
 *
 * Deliberately ignores the caller's status / name filters: a workflow must
 * land in the same block whether the list was filtered or not, so the corpus
 * is always every non-deleted workflow.
 */
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

/**
 * The naming grounding: the families that already exist in this tenant's
 * catalog, largest first.
 *
 * This is the whole point of leverage for keeping a catalog organised. The
 * category is derived from the slug, so the slug IS the organising decision —
 * and that decision is made once, at authoring time, when no `wf_<slug>` tool
 * is registered yet and renaming costs nothing. Naming each new workflow in
 * ignorance of the existing families is what produced a dozen one-off slugs;
 * showing the families at that moment is what stops it.
 *
 * Returns `null` when the catalog has no families yet, so a fresh tenant gets
 * no prompt section rather than an empty, confusing one.
 */
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

/**
 * Resolve the derived predicates, or `null` when the caller asked for neither —
 * which lets the list paths keep their existing SQL-paged fast route untouched.
 */
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
