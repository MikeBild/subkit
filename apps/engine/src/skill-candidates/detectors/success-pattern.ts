import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { now } from "../../utils/clock.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_SUCCESS_COUNT = 10;
const LOOKBACK_DAYS = 30;

interface StepRecord {
  execution_id: string;
  step_key: string;
  workflow_id: string;
  request_meta: Record<string, unknown> | null;
}

export async function detectSuccessPatterns(tenant_id: string, exec: Db): Promise<PatternSignal[]> {
  const cutoff = new Date(now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await exec
    .select({
      execution_id: executionSteps.execution_id,
      step_key: executionSteps.step_key,
      workflow_id: executions.workflow_id,
      request_meta: executionSteps.request_meta,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executionSteps.execution_id, executions.id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.kind, "request"),
        eq(executionSteps.status, "succeeded"),
        gte(executionSteps.started_at, cutoff),
      ),
    );

  if (rows.length < MIN_SUCCESS_COUNT) {
    logger.debug({
      module: "skill",
      action: "detector.success.below_threshold",
      msg: "not enough successful steps to derive patterns",
      tenant_id,
      rows: rows.length,
      threshold: MIN_SUCCESS_COUNT,
      lookback_days: LOOKBACK_DAYS,
    });
    return [];
  }

  const byWorkflow = new Map<string, StepRecord[]>();
  for (const row of rows) {
    if (!row.workflow_id) continue;
    const list = byWorkflow.get(row.workflow_id) ?? [];
    list.push({
      execution_id: row.execution_id,
      step_key: row.step_key,
      workflow_id: row.workflow_id,
      request_meta: row.request_meta as Record<string, unknown> | null,
    });
    byWorkflow.set(row.workflow_id, list);
  }

  const signals: PatternSignal[] = [];

  for (const [workflowId, steps] of byWorkflow) {
    if (steps.length < MIN_SUCCESS_COUNT) continue;

    const selectorsWithMeta = steps.filter(
      (s) =>
        s.request_meta &&
        typeof (s.request_meta as Record<string, unknown>).data_selector === "string",
    );
    if (selectorsWithMeta.length >= MIN_SUCCESS_COUNT) {
      const selectorCounts = new Map<string, number>();
      for (const s of selectorsWithMeta) {
        const sel = (s.request_meta as Record<string, unknown>).data_selector as string;
        selectorCounts.set(sel, (selectorCounts.get(sel) ?? 0) + 1);
      }

      for (const [selector, count] of selectorCounts) {
        const ratio = count / selectorsWithMeta.length;
        if (ratio >= 0.8 && count >= MIN_SUCCESS_COUNT) {
          const fingerprint = createHash("sha256")
            .update(`success:${workflowId}:data_selector:${selector}`)
            .digest("hex")
            .slice(0, 32);

          signals.push({
            pattern_kind: "success_pattern",
            scope: "workflow",
            workflow_id: workflowId,
            title: `Consistent data selector pattern`,
            body: `Successful request steps consistently use data_selector '${selector}' (${Math.round(ratio * 100)}% of ${selectorsWithMeta.length} steps). Consider documenting this as a standard pattern.`,
            examples: [`Used in ${count} of ${selectorsWithMeta.length} successful request steps`],
            best_practices: ["Use this selector pattern for new steps targeting the same API"],
            pitfalls: [],
            doc_refs: [],
            fingerprint,
            confidence: computeConfidence(count, ratio),
            evidence: selectorsWithMeta.slice(0, 50).map((s) => ({
              execution_id: s.execution_id,
              evidence_type: "step_success",
              summary: `Step '${s.step_key}' used data_selector '${selector}'`,
            })),
          });
        }
      }
    }
  }

  logger.debug({
    module: "skill",
    action: "detector.success.result",
    msg: "success pattern detector finished",
    tenant_id,
    steps_scanned: rows.length,
    groups_found: signals.length,
  });
  return signals;
}
