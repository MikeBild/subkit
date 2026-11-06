import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { domainsOfItem } from "../agent/domains.ts";
import { connectors as connectorsTable } from "../db/schema/index.ts";
import { loadChunks } from "../llm/runtime/context-assembler/loaders.ts";
import type { ToolContext } from "./tools/index.ts";

const DOCS_EXCERPT_CAP_CHARS = 1_500;
const DOCS_SNIPPETS_PER_CONNECTOR = 4;

export interface GroundedConnector {
  id: string;
  slug: string;
  display_name: string;
  driver: string;
  base_url: string | null;
  auth_type: string;
  description: string | null;
  self_description: { links?: { url?: string }[] } | null;
  environment?: "dev" | "prod";
  category?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveConnectors(
  ctx: Pick<ToolContext, "db" | "tenant_id">,
  refs: string[],
): Promise<{ resolved: GroundedConnector[]; unresolved: string[] }> {
  const ids = [...new Set(refs.filter((r) => UUID_RE.test(r)))];
  const slugs = [...new Set(refs.filter((r) => !UUID_RE.test(r)))];
  if (ids.length === 0 && slugs.length === 0) return { resolved: [], unresolved: [] };
  const idFilter = ids.length > 0 ? inArray(connectorsTable.id, ids) : null;
  const slugFilter = slugs.length > 0 ? inArray(connectorsTable.slug, slugs) : null;
  const refFilter =
    idFilter && slugFilter ? or(idFilter, slugFilter) : (idFilter ?? slugFilter ?? undefined);
  const rows = await ctx.db
    .select({
      id: connectorsTable.id,
      slug: connectorsTable.slug,
      display_name: connectorsTable.display_name,
      driver: connectorsTable.driver,
      base_url: connectorsTable.base_url,
      auth_type: connectorsTable.auth_type,
      config: connectorsTable.config,
      self_description: connectorsTable.self_description,
      environment: connectorsTable.environment,
      category: connectorsTable.category,
    })
    .from(connectorsTable)
    .where(
      and(
        eq(connectorsTable.tenant_id, ctx.tenant_id),
        isNull(connectorsTable.deleted_at),
        refFilter,
      ),
    );
  const resolved: GroundedConnector[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    driver: row.driver,
    base_url: row.base_url,
    auth_type: row.auth_type,
    description:
      typeof (row.config as Record<string, unknown> | null)?.description === "string"
        ? ((row.config as Record<string, unknown>).description as string)
        : null,
    self_description: (row.self_description as { links?: { url?: string }[] } | null) ?? null,
    environment: row.environment,
    category: row.category,
  }));
  const seen = new Set<string>();
  for (const r of resolved) {
    seen.add(r.id);
    seen.add(r.slug);
  }
  const unresolved = refs.filter((r) => !seen.has(r));
  return { resolved, unresolved };
}

export async function loadDocsExcerpt(ctx: ToolContext, goal: string, c: GroundedConnector) {
  const chunks = await loadChunks(ctx.tenant_id, c.id, goal, ctx.db);
  const lines: string[] = [];
  let budget = DOCS_EXCERPT_CAP_CHARS;
  for (const chunk of chunks.slice(0, DOCS_SNIPPETS_PER_CONNECTOR)) {
    const head = chunk.title ?? chunk.path ?? "(doc)";
    const snippet = chunk.snippet.length > budget ? chunk.snippet.slice(0, budget) : chunk.snippet;
    lines.push(`- ${head}: ${snippet.replace(/\s+/g, " ").trim()}`);
    budget -= snippet.length;
    if (budget <= 0) break;
  }
  return lines;
}

export function connectorDomains(
  connectors: readonly GroundedConnector[],
  explicit: readonly string[] | undefined,
): string[] {
  return [
    ...new Set([
      ...(explicit ?? []),
      ...connectors.flatMap((c) => domainsOfItem({ tags: [], category: c.category ?? null })),
    ]),
  ];
}
