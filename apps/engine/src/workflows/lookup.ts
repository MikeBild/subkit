// Slug-or-UUID workflow resolver. Used by every place that accepts a
// workflow reference from an LLM, a CLI argument, or the fast-path
// matcher (chat `wf_<slug>` dispatcher, `run_workflow(workflow=…)`
// fallback, fast-path "run <slug>" branch, `sk executions rerun`,
// `sk workflows run`).
//
// Single source of truth so the slug vs uuid choice is made once at
// the boundary instead of every callsite re-implementing the heuristic.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";

export interface WorkflowLookupResult {
  id: string;
  slug: string;
  name: string;
  current_version_id: string | null;
  is_tool: boolean;
}

// Loose UUID v4 / v7 check — drizzle's `eq(workflows.id, …)` would
// otherwise produce a malformed SQL cast for non-UUID strings.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(ref: string): boolean {
  return UUID_RE.test(ref);
}

/**
 * Resolve a workflow by id or slug, scoped to the tenant. Soft-deleted
 * rows are excluded. Returns null when nothing matches.
 */
export async function resolveWorkflowByIdOrSlug(
  db: Db,
  tenant_id: string,
  ref: string,
): Promise<WorkflowLookupResult | null> {
  const isUuid = looksLikeUuid(ref);
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      current_version_id: workflows.current_version_id,
      is_tool: workflows.is_tool,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isUuid ? eq(workflows.id, ref) : eq(workflows.slug, ref),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
