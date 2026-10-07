import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { knowledgeSources } from "../db/schema/knowledge_sources.ts";
import type { KnowledgeSourceView, ListKnowledgeSourcesParams } from "./types.ts";
import { knowledgeSourceRowToView } from "./view.ts";

function catalogConditions(
  p: Omit<ListKnowledgeSourcesParams, "limit" | "offset" | "sort" | "order">,
) {
  const tenantConds = [
    eq(knowledgeSources.tenant_id, p.tenant_id),
    isNull(knowledgeSources.deleted_at),
  ];
  if (p.scope) tenantConds.push(eq(knowledgeSources.scope, p.scope));
  if (p.workflow_id) tenantConds.push(eq(knowledgeSources.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(knowledgeSources.status, p.status));
  if (p.category) tenantConds.push(eq(knowledgeSources.category, p.category));
  if (p.q) {
    const needle = `%${p.q}%`;
    const search = or(
      ilike(knowledgeSources.name, needle),
      ilike(knowledgeSources.slug, needle),
      ilike(knowledgeSources.description, needle),
      ilike(knowledgeSources.category, needle),
      ilike(knowledgeSources.source_uri, needle),
    );
    if (search) tenantConds.push(search);
  }
  return tenantConds;
}

export async function listKnowledgeSources(
  p: ListKnowledgeSourcesParams,
  exec?: Executor,
): Promise<KnowledgeSourceView[]> {
  const db = exec ?? getDb();
  const tenantConds = catalogConditions(p);
  const limit = Math.min(Math.max(1, p.limit ?? 50), 500);
  const offset = Math.max(0, p.offset ?? 0);
  const sortColumn =
    p.sort === "name"
      ? knowledgeSources.name
      : p.sort === "status"
        ? knowledgeSources.status
        : p.sort === "source_type"
          ? knowledgeSources.source_type
          : p.sort === "bytes_total"
            ? knowledgeSources.bytes_total
            : p.sort === "updated_at"
              ? knowledgeSources.updated_at
              : knowledgeSources.created_at;
  const ordered = p.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(...tenantConds))
    .orderBy(ordered, asc(knowledgeSources.id))
    .limit(limit)
    .offset(offset);
  return rows.map(knowledgeSourceRowToView);
}

export async function countKnowledgeSources(
  p: Omit<ListKnowledgeSourcesParams, "limit" | "offset" | "sort" | "order">,
  exec?: Executor,
): Promise<number> {
  const db = exec ?? getDb();
  const tenantConds = catalogConditions(p);
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(knowledgeSources)
    .where(and(...tenantConds));
  return Number(row?.total ?? 0);
}

export async function getKnowledgeSource(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<KnowledgeSourceView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        eq(knowledgeSources.id, id),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ? knowledgeSourceRowToView(rows[0]) : null;
}
