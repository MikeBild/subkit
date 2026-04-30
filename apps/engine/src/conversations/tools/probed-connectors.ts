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

import { and, desc, eq, inArray } from "drizzle-orm";
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
export async function collectProbedConnectorSlugs(
  ctx: ToolContext,
  steps: ReadonlyArray<Record<string, unknown>>,
): Promise<ReadonlySet<string>> {
  const connectorIds = new Set<string>();
  for (const s of steps) {
    if (
      typeof s === "object" &&
      s !== null &&
      typeof (s as { connector_id?: unknown }).connector_id === "string"
    ) {
      connectorIds.add((s as { connector_id: string }).connector_id);
    }
  }
  if (connectorIds.size === 0) return new Set<string>();
  try {
    const connectorRows = await ctx.db
      .select({ id: connectorsTable.id, slug: connectorsTable.slug })
      .from(connectorsTable)
      .where(
        and(
          eq(connectorsTable.tenant_id, ctx.tenant_id),
          inArray(connectorsTable.id, [...connectorIds]),
        ),
      );
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
