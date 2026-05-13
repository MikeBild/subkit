// Lookup of connector slugs that have been successfully probed in
// the current conversation. Used by the loop-authoring gate as
// shape evidence — when the loop's referenced upstream `request`
// step routes through an already-probed connector, the probe
// counts as proof of shape and the gate skips it.
//
// Mirrors the reference impl's `call_system → build_tool` flow:
// probes ARE the shape-discovery surface. Pre-fix subkit's gate
// required an EXTRA `dry_run_workflow` between the probe and the
// build, even when the LLM had just successfully exercised the
// exact same endpoint via `probe_connector` (session 0a01c5f3
// 16:18:26).

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { auditLog, connectors as connectorsTable } from "../../db/schema/index.ts";
import type { ToolContext } from "./index.ts";

/**
 * Best-effort lookup. Reads `audit_log` rows with
 * `action = "conversation.probe_connector"` and `result = "success"`
 * for connectors referenced by the workflow's `request` steps.
 * Returns the union of probed slugs. Always returns an empty set on
 * any DB error so the gate falls back to its conservative default
 * (refuse without recorded preview).
 */
/**
 * Walk a step's serialized JSON for `${connector.<slug>.*}` placeholder
 * references. The reference impl AND legacy subkit workflows bind a
 * step to a connector either via an explicit `connector_id` field OR
 * via URL / header / body placeholders that name the connector slug.
 * Both bindings are equally valid at runtime; the gate's exemption
 * must therefore honour both.
 */
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

export async function collectProbedConnectorSlugs(
  ctx: ToolContext,
  steps: ReadonlyArray<Record<string, unknown>>,
): Promise<ReadonlySet<string>> {
  const connectorIds = new Set<string>();
  // Two binding shapes both count:
  //   1. explicit `step.connector_id` (UUID) — the historical primary
  //      form used by `request` / `graphql` steps authored through
  //      `propose_step`.
  //   2. `${connector.<slug>.*}` placeholders anywhere in the step
  //      config (URL, headers, body, queries) — the alternative form
  //      legacy + reference-impl-style workflows use. Walking these
  //      gives the gate the same probe-evidence exemption regardless
  //      of which binding style the LLM picked.
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
  if (connectorIds.size === 0 && slugCandidates.size === 0) return new Set<string>();
  try {
    // Resolve {slug, id} for both binding sources in one query. When
    // both binding shapes are present we OR the predicates; otherwise
    // a single inArray is enough.
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
