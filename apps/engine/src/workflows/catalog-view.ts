import type { WorkflowOperatingStatus } from "@shared/workflow-operating-status.ts";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  CATALOG_KINDS,
  type CatalogKind,
  compareCategoryCounts,
  PLATFORM_CATEGORY,
  UNCATEGORIZED,
} from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { type Executor, getDb } from "../db/client.ts";
import { connectors, files, knowledgeSources, skills, workflows } from "../db/schema/index.ts";
import { workflowIdsUsingConnector } from "./connector-refs.ts";
import type { OperatingStatusAccess } from "./operating-status.ts";

export interface CatalogFilterOptions {
  description_source?: "llm" | "human";
  category?: string;
  connector?: string;
}

export interface ListWorkflowsOptions extends CatalogFilterOptions {
  operating_status?: WorkflowOperatingStatus;
  operating_access?: OperatingStatusAccess;
  include_operating_status?: boolean;
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
  if (opts.description_source)
    conds.push(eq(workflows.description_source, opts.description_source));
  if (opts.description_source === "llm")
    conds.push(sql`length(trim(coalesce(${workflows.description}, ''))) > 0`);
  const category = opts.category?.trim();
  if (category) conds.push(eq(workflows.category, category));
  if (opts.name_contains) conds.push(ilike(workflows.name, `%${opts.name_contains}%`));
  if (opts.q) {
    const needle = `%${opts.q}%`;
    const search = or(
      ilike(workflows.name, needle),
      ilike(workflows.slug, needle),
      ilike(workflows.description, needle),
      ilike(workflows.category, needle),
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

export interface CatalogFilter {
  keep(row: { id: string }): boolean;
}

export async function resolveCatalogFilter(
  tenant_id: string,
  opts: CatalogFilterOptions,
  exec?: Executor,
): Promise<CatalogFilter | null> {
  const db = exec ?? getDb();
  const wantConnector = opts.connector?.trim();
  if (!wantConnector) return null;
  const connectorMatches = await workflowIdsUsingConnector(tenant_id, wantConnector, db);
  return {
    keep(row) {
      return connectorMatches.has(row.id);
    },
  };
}

const CATALOG_TABLES = {
  workflow: workflows,
  connector: connectors,
  knowledge_source: knowledgeSources,
  skill: skills,
  file: files,
} as const;

export interface CategoryUsage {
  category: string;
  total: number;
  counts: Record<CatalogKind, number>;
  llm_counts: Record<CatalogKind, number>;
}

function liveRows(kind: CatalogKind) {
  if (kind === "workflow") return isNull(workflows.deleted_at);
  if (kind === "connector") return isNull(connectors.deleted_at);
  if (kind === "knowledge_source") return isNull(knowledgeSources.deleted_at);
  if (kind === "file") return isNull(files.deleted_at);
  return undefined;
}

export async function loadCategoryVocabulary(
  tenant_id: string,
  exec?: Executor,
): Promise<CategoryUsage[]> {
  const db = exec ?? getDb();
  const byCategory = new Map<string, CategoryUsage>();
  for (const kind of CATALOG_KINDS) {
    const table = CATALOG_TABLES[kind];
    const live = liveRows(kind);
    const rows = await db
      .select({
        category: table.category,
        c: sql<number>`count(*)::int`,
        llm: sql<number>`count(*) FILTER (WHERE ${table.description_source} = 'llm' AND length(trim(coalesce(${table.description}, ''))) > 0)::int`,
      })
      .from(table)
      .where(and(eq(table.tenant_id, tenant_id), ...(live ? [live] : [])))
      .groupBy(table.category);
    for (const row of rows) {
      const usage = byCategory.get(row.category) ?? {
        category: row.category,
        total: 0,
        counts: { workflow: 0, connector: 0, knowledge_source: 0, skill: 0, file: 0 },
        llm_counts: { workflow: 0, connector: 0, knowledge_source: 0, skill: 0, file: 0 },
      };
      usage.counts[kind] = Number(row.c);
      usage.llm_counts[kind] = Number(row.llm);
      usage.total += Number(row.c);
      byCategory.set(row.category, usage);
    }
  }
  return [...byCategory.values()].sort((a, b) =>
    compareCategoryCounts(
      { category: a.category, count: a.total },
      { category: b.category, count: b.total },
    ),
  );
}

export class CategoryRenameRefused extends Error {}

export interface RenameCategoryInput {
  tenant_id: string;
  from: string;
  to: string;
  actor_type?: AuditActorType;
  actor_id?: string | null;
}

export async function renameCategory(
  input: RenameCategoryInput,
  exec?: Executor,
): Promise<{ moved: Record<CatalogKind, number>; total: number }> {
  const db = exec ?? getDb();
  const moved: Record<CatalogKind, number> = {
    workflow: 0,
    connector: 0,
    knowledge_source: 0,
    skill: 0,
    file: 0,
  };
  if (input.from === input.to) return { moved, total: 0 };
  if (input.from === UNCATEGORIZED || input.from === PLATFORM_CATEGORY) {
    throw new CategoryRenameRefused(`\`${input.from}\` cannot be renamed`);
  }
  if (input.to === PLATFORM_CATEGORY) {
    throw new CategoryRenameRefused(
      `\`${PLATFORM_CATEGORY}\` is reserved for the engine's own guidance`,
    );
  }
  await db.transaction(async (tx) => {
    for (const kind of CATALOG_KINDS) {
      const table = CATALOG_TABLES[kind];
      const updated = await tx
        .update(table)
        .set(
          input.to === UNCATEGORIZED
            ? {
                category: input.to,
                category_source: "llm",
                catalog_input_hash: null,
                catalog_described_at: null,
              }
            : { category: input.to, category_source: "human" },
        )
        .where(and(eq(table.tenant_id, input.tenant_id), eq(table.category, input.from)))
        .returning({ id: table.id });
      moved[kind] = updated.length;
    }
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_type ?? "system",
        actor_id: input.actor_id ?? null,
        action: AuditAction.CATALOG_CATEGORY_RENAMED,
        resource_type: "catalog_category",
        resource_id: input.to,
        result: "success",
        metadata: {
          from: input.from,
          to: input.to,
          moved,
          total: Object.values(moved).reduce((sum, n) => sum + n, 0),
        },
      },
      tx,
    );
  });
  const total = Object.values(moved).reduce((sum, n) => sum + n, 0);
  return { moved, total };
}

const CATALOG_SUMMARY_MAX_BLOCKS = 15;

export async function buildCatalogSummaryLine(
  tenant_id: string,
  readable: ReadonlySet<CatalogKind>,
  exec?: Executor,
): Promise<string | null> {
  const count = (v: CategoryUsage) =>
    (["workflow", "connector", "knowledge_source"] as const)
      .filter((kind) => readable.has(kind))
      .reduce((sum, kind) => sum + v.counts[kind], 0);
  const business = (await loadCategoryVocabulary(tenant_id, exec))
    .filter((v) => v.category !== UNCATEGORIZED && v.category !== PLATFORM_CATEGORY)
    .map((v) => ({ category: v.category, count: count(v) }))
    .filter((v) => v.count > 0)
    .sort(compareCategoryCounts);
  if (business.length === 0) return null;
  const shown = business.slice(0, CATALOG_SUMMARY_MAX_BLOCKS);
  const blocks = shown.map((v) => `${v.category} (${v.count})`).join(", ");
  const more = business.length > shown.length ? ` and ${business.length - shown.length} more` : "";
  return `Catalog blocks of this tenant: ${blocks}${more}. Pass one as \`category\` to list_* or find_* to see everything in it.`;
}
