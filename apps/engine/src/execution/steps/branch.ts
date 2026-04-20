// Branch step. Evaluates a JSONata predicate against the scope. Returns
// the chosen arm as the output. The engine consumer reads `output.arm` and
// `output.next` to decide which downstream step ids to skip.

import jsonata from "jsonata";
import { logger } from "../../logging/logger.ts";
import type { BranchStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export async function runBranchStep(p: {
  ctx: StepRunContext;
  step: BranchStep;
  scope: Record<string, unknown>;
}): Promise<StepResult> {
  const start = Date.now();
  try {
    const expr = jsonata(p.step.when);
    const matched = await expr.evaluate(p.scope);
    const truthy = !!matched;
    logger.debug({
      module: "execution",
      action: "step.branch.evaluated",
      step_id: p.step.id,
      matched: truthy,
      arm: truthy ? "then" : "else",
    });
    return {
      status: "succeeded",
      output: { matched: truthy, arm: truthy ? "then" : "else" },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "step.branch.error",
      step_id: p.step.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "branch_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
