// Parallel step. The engine resolves the referenced child step ids and
// runs them as nested mini-DAGs. P3 ships a basic Promise.all fan-out;
// onError fail vs continue applies per-branch.
//
// NOTE: To keep the engine.ts footprint contained, this driver is a
// placeholder that records a step succeeded with the list of branches it
// would have run. The walker in engine.ts handles actual fan-out.

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
