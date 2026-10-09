import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import {
  assertHistoryScope,
  assertHistoryStep,
  type WorkflowHistoryFacts,
} from "./history-read-facts.ts";

export interface BoundaryContradiction {
  step_id: string;
  declared_prefix: string;
  observed_key: string;
  observed_at: string;
}

async function lastObservedKeys(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  step_ids: readonly string[],
  facts?: WorkflowHistoryFacts,
): Promise<Map<string, { key: string; at: Date }>> {
  const observed = new Map<string, { key: string; at: Date }>();
  if (facts) {
    assertHistoryScope(facts, tenant_id, workflow_id);
    for (const step_id of step_ids) assertHistoryStep(facts, tenant_id, workflow_id, step_id);
  }
  if (step_ids.length === 0) return observed;
  const rows = facts
    ? (facts.storage.get(workflow_id) ?? [])
        .filter((row) => step_ids.includes(row.step_key))
        .slice(0, 500)
    : await db
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
    if (!row.key || observed.has(row.step_key)) continue;
    observed.set(row.step_key, { key: row.key, at: row.at });
  }
  return observed;
}

export async function contradictedStorageBoundaries(
  db: Executor,
  params: {
    tenant_id: string;
    workflow_id: string;
    declared: ReadonlyArray<{ step_id: string; key_prefix: string }>;
  },
  facts?: WorkflowHistoryFacts,
): Promise<BoundaryContradiction[]> {
  if (params.declared.length === 0) return [];
  const observed = await lastObservedKeys(
    db,
    params.tenant_id,
    params.workflow_id,
    params.declared.map((entry) => entry.step_id),
    facts,
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
