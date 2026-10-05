import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { classifyPersistedFailure, type PreviewClassification } from "../../execution/classify.ts";
import { logger } from "../../logging/logger.ts";
import { now } from "../../utils/clock.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_FAILURE_COUNT = 3;
const LOOKBACK_DAYS = 30;

interface FailureGroup {
  workflow_id: string;
  step_key: string;
  error_kind: string;
  cause_class: PreviewClassification;
  count: number;
  execution_ids: string[];
}

export async function detectFailurePatterns(tenant_id: string, exec: Db): Promise<PatternSignal[]> {
  const cutoff = new Date(now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

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

  if (rows.length === 0) {
    logger.debug({
      module: "skill",
      action: "detector.failure.empty",
      msg: "no failed steps in lookback window",
      tenant_id,
      lookback_days: LOOKBACK_DAYS,
    });
    return [];
  }

  const groups = new Map<string, FailureGroup>();

  for (const row of rows) {
    if (!row.workflow_id) continue;
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
        cause_class: classifyPersistedFailure({ status: "failed", error: row.error })
          .classification,
        count: 1,
        execution_ids: [row.execution_id],
      });
    }
  }

  const signals: PatternSignal[] = [];

  for (const [, group] of groups) {
    if (group.count < MIN_FAILURE_COUNT) continue;

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
      examples: [`${group.count} failures with error kind '${group.error_kind}'`],
      facts: {
        kind: "recurring_failure",
        step_key: group.step_key,
        error_kind: group.error_kind,
        cause_class: group.cause_class,
        count: group.count,
        lookback_days: LOOKBACK_DAYS,
      },
      best_practices: [
        "Add input validation before this step",
        "Consider a branch step to handle this case",
      ],
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

  logger.debug({
    module: "skill",
    action: "detector.failure.result",
    msg: "failure pattern detector finished",
    tenant_id,
    failures_scanned: rows.length,
    groups_found: signals.length,
    threshold: MIN_FAILURE_COUNT,
  });
  return signals;
}
