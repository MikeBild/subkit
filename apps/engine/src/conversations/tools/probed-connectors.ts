import { and, desc, eq, inArray, or } from "drizzle-orm";
import { auditLog, connectors as connectorsTable } from "../../db/schema/index.ts";
import type { ToolContext } from "./index.ts";

function collectPlaceholderConnectorSlugs(step: Record<string, unknown>): string[] {
  const out = new Set<string>();
  let json: string;
  try {
    json = JSON.stringify(step);
  } catch {
    return [];
  }
  const re = /\$\{\s*connector\.([a-zA-Z][a-zA-Z0-9_-]*)\b/g;
  for (let m = re.exec(json); m !== null; m = re.exec(json)) {
    const slug = m[1];
    if (slug) out.add(slug);
  }
  return [...out];
}

export function collectDraftConnectorRefs(steps: ReadonlyArray<unknown>): {
  connectorIds: Set<string>;
  slugCandidates: Set<string>;
} {
  const connectorIds = new Set<string>();
  const slugCandidates = new Set<string>();
  for (const s of steps) {
    if (typeof s !== "object" || s === null) continue;
    if (typeof (s as { connector_id?: unknown }).connector_id === "string") {
      connectorIds.add((s as { connector_id: string }).connector_id);
    }
    for (const slug of collectPlaceholderConnectorSlugs(s as Record<string, unknown>)) {
      slugCandidates.add(slug);
    }
  }
  return { connectorIds, slugCandidates };
}

export async function collectProbedConnectorSlugs(
  ctx: ToolContext,
  steps: ReadonlyArray<Record<string, unknown>>,
): Promise<ReadonlySet<string>> {
  const { connectorIds, slugCandidates } = collectDraftConnectorRefs(steps);
  if (connectorIds.size === 0 && slugCandidates.size === 0) return new Set<string>();
  try {
    const idFilter = connectorIds.size > 0 ? inArray(connectorsTable.id, [...connectorIds]) : null;
    const slugFilter =
      slugCandidates.size > 0 ? inArray(connectorsTable.slug, [...slugCandidates]) : null;
    const idOrSlugFilter =
      idFilter && slugFilter ? or(idFilter, slugFilter) : (idFilter ?? slugFilter);
    const connectorRows = await ctx.db
      .select({ id: connectorsTable.id, slug: connectorsTable.slug })
      .from(connectorsTable)
      .where(and(eq(connectorsTable.tenant_id, ctx.tenant_id), idOrSlugFilter ?? undefined));
    if (connectorRows.length === 0) return new Set<string>();
    const probeRows = await ctx.db
      .select({ resource_id: auditLog.resource_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "conversation.probe_connector"),
          eq(auditLog.result, "success"),
          inArray(
            auditLog.resource_id,
            connectorRows.map((c) => c.id),
          ),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(50);
    if (probeRows.length === 0) return new Set<string>();
    const probedConnectorIds = new Set(probeRows.map((r) => r.resource_id));
    const out = new Set<string>();
    for (const c of connectorRows) {
      if (probedConnectorIds.has(c.id)) out.add(c.slug);
    }
    return out;
  } catch {
    return new Set<string>();
  }
}
