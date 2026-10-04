import type { ParallelStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export async function runParallelStep(p: {
  ctx: StepRunContext;
  step: ParallelStep;
}): Promise<StepResult> {
  return {
    status: "succeeded",
    output: { branches: p.step.branches },
    retry_count: 0,
    duration_ms: 0,
  };
}
