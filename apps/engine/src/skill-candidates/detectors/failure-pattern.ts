// Failure Pattern Detector — identifies recurring step failures with
// consistent error conditions.
//
// Input: Failed execution steps for a tenant (last 30 days)
// Grouping key: (workflow_id, step_key, error kind)
// Threshold: >= 3 failures in group
// Output: Workflow-scoped PatternSignal

import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_FAILURE_COUNT = 3;
const LOOKBACK_DAYS = 30;

interface FailureGroup {
  workflow_id: string;
  step_key: string;
  error_kind: string;
  count: number;
  execution_ids: string[];
}

export async function detectFailurePatterns(
  tenant_id: string,
  exec: Db,
): Promise<PatternSignal[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Query failed steps joined with their executions
  const rows = await exec
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      error: executionSteps.error,
      workflow_id: executions.workflow_id,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executionSteps.execution_id, executions.id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.status, "failed"),
        gte(executionSteps.started_at, cutoff),
      ),
    );

  if (rows.length === 0) return [];

  // Group by (workflow_id, step_key, error_kind)
  const groups = new Map<string, FailureGroup>();

  for (const row of rows) {
    const err = row.error as Record<string, unknown> | null;
    const errorKind = (err?.kind as string) ?? (err?.code as string) ?? "unknown";

    const key = `${row.workflow_id}:${row.step_key}:${errorKind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (!existing.execution_ids.includes(row.execution_id)) {
        existing.execution_ids.push(row.execution_id);
      }
    } else {
      groups.set(key, {
        workflow_id: row.workflow_id,
        step_key: row.step_key,
        error_kind: errorKind,
        count: 1,
        execution_ids: [row.execution_id],
      });
    }
  }

  const signals: PatternSignal[] = [];

  for (const [, group] of groups) {
    if (group.count < MIN_FAILURE_COUNT) continue;

    // Count total failures on this step_key for consistency ratio
    const totalForStep = rows.filter(
      (r) => r.workflow_id === group.workflow_id && r.step_key === group.step_key,
    ).length;
    const ratio = totalForStep > 0 ? group.count / totalForStep : 0;

    const fingerprint = createHash("sha256")
      .update(`failure:${group.workflow_id}:${group.step_key}:${group.error_kind}`)
      .digest("hex")
      .slice(0, 32);

    signals.push({
      pattern_kind: "failure_pattern",
      scope: "workflow",
      workflow_id: group.workflow_id,
      title: `Recurring failure on step '${group.step_key}'`,
      body: `Step '${group.step_key}' fails with '${group.error_kind}' consistently (${group.count} times in ${LOOKBACK_DAYS} days). Consider adding input validation or a guard step.`,
      examples: [
        `${group.count} failures with error kind '${group.error_kind}'`,
      ],
      best_practices: ["Add input validation before this step", "Consider a branch step to handle this case"],
      pitfalls: [],
      doc_refs: [],
      fingerprint,
      confidence: computeConfidence(group.count, ratio),
      evidence: group.execution_ids.slice(0, 50).map((id) => ({
        execution_id: id,
        evidence_type: "step_failure",
        summary: `Step '${group.step_key}' failed with '${group.error_kind}'`,
      })),
    });
  }

  return signals;
}
