// What a step has actually written, held against the folder its author
// declared.
//
// A storage boundary is declared by hand and then never exercised: a write is
// HELD in every preview, so a wrong folder survives review and the approval
// dialog shows it beside the boundaries that were measured, reading exactly as
// plausible. The first scheduled run after the approval is refused, and
// repeats nightly.
//
// Two production workflows were approved that way on one day. In both, the
// author gave a step the folder of its neighbour: a manifest writer declared
// `v1/latest/` (its sibling's folder) while writing `v1/infrastructure/
// manifests/…`, and a "latest" writer declared `v1/growth/` while writing
// `v1/latest/growth-weekly.json`. The runtime knew the real key each time —
// it is on every successful step row — and nothing compared the two.
//
// The rule here fires ONLY on a contradiction: a key this step really wrote,
// under this workflow, that the declared folder does not contain. A step that
// has never run, or ran without recording a key, produces nothing. A check
// that reports what it cannot know is the defect this product keeps paying
// for — it makes an authoring model rewrite code that was right.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";

/** One step whose declared folder is contradicted by what it wrote. */
export interface BoundaryContradiction {
  step_id: string;
  /** The folder the author declared, as `s3.scope.key_prefix`. */
  declared_prefix: string;
  /** A key this step really wrote, which that folder does not contain. */
  observed_key: string;
  /** When that write happened, so a reviewer can judge how current it is. */
  observed_at: string;
}

/**
 * The most recent key each named step actually wrote for this workflow.
 *
 * Only successful steps count: a refused or failed write proves nothing about
 * where the step belongs. Reads and listings are included when they recorded a
 * key, because the same argument applies to them.
 */
async function lastObservedKeys(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  step_ids: readonly string[],
): Promise<Map<string, { key: string; at: Date }>> {
  const observed = new Map<string, { key: string; at: Date }>();
  if (step_ids.length === 0) return observed;
  const rows = await db
    .select({
      step_key: executionSteps.step_key,
      key: sql<string>`${executionSteps.request_meta} ->> 'key'`,
      at: executions.created_at,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        eq(executionSteps.status, "succeeded"),
        isNotNull(executionSteps.request_meta),
        sql`${executionSteps.request_meta} ->> 'key' IS NOT NULL`,
        sql`${executionSteps.step_key} = ANY(${sql.param(step_ids as string[])}::text[])`,
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(500);
  for (const row of rows) {
    // Ordered newest first, so the first sighting of a step id is its latest.
    if (!row.key || observed.has(row.step_key)) continue;
    observed.set(row.step_key, { key: row.key, at: row.at });
  }
  return observed;
}

/**
 * Which declared folders this workflow's own history contradicts.
 *
 * Returns an empty list when nothing can be said — no history, no recorded
 * keys, or every observed key inside its folder. Silence here means "no
 * evidence against", never "verified".
 */
export async function contradictedStorageBoundaries(
  db: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    declared: ReadonlyArray<{ step_id: string; key_prefix: string }>;
  },
): Promise<BoundaryContradiction[]> {
  if (params.declared.length === 0) return [];
  const observed = await lastObservedKeys(
    db,
    params.tenant_id,
    params.workflow_id,
    params.declared.map((entry) => entry.step_id),
  );
  const contradictions: BoundaryContradiction[] = [];
  for (const entry of params.declared) {
    const seen = observed.get(entry.step_id);
    if (!seen) continue;
    if (seen.key.startsWith(entry.key_prefix)) continue;
    contradictions.push({
      step_id: entry.step_id,
      declared_prefix: entry.key_prefix,
      observed_key: seen.key,
      observed_at: seen.at.toISOString(),
    });
  }
  return contradictions.sort((a, b) => (a.step_id < b.step_id ? -1 : 1));
}
