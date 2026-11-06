import { listSuccessfulProbeResourceIds } from "../../audit/probe-evidence.ts";
import { listConnectorsByIdsOrSlugs } from "../../connectors/tool-lookups.ts";
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
    const connectorRows = await listConnectorsByIdsOrSlugs(
      ctx.db,
      ctx.tenant_id,
      [...connectorIds],
      [...slugCandidates],
    );
    if (connectorRows.length === 0) return new Set<string>();
    const probeResourceIds = await listSuccessfulProbeResourceIds(
      ctx.db,
      ctx.tenant_id,
      connectorRows.map((c) => c.id),
      50,
    );
    if (probeResourceIds.length === 0) return new Set<string>();
    const probedConnectorIds = new Set(probeResourceIds);
    const out = new Set<string>();
    for (const c of connectorRows) {
      if (probedConnectorIds.has(c.id)) out.add(c.slug);
    }
    return out;
  } catch {
    return new Set<string>();
  }
}
