// Loop step. Iterates the configured collection. Hard cap 10,000.
// In P3 we only support a `transform`-shaped body via JSONata —
// engine.ts will call this driver and merge the results array.

import jsonata from "jsonata";
import { logger } from "../../logging/logger.ts";
import type { LoopStep } from "../../workflows/types.ts";
import { applySelector } from "../selectors.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export const LOOP_ITERATION_CAP = 10_000;

export async function runLoopStep(p: {
  ctx: StepRunContext;
  step: LoopStep;
  scope: Record<string, unknown>;
}): Promise<StepResult> {
  const start = Date.now();
  try {
    let collection: unknown;
    if (p.step.over.startsWith("$.") || p.step.over === "$") {
      collection = applySelector(p.step.over, p.scope);
    } else {
      collection = await jsonata(p.step.over).evaluate(p.scope);
    }
    if (!Array.isArray(collection)) {
      return {
        status: "succeeded",
        output: [],
        retry_count: 0,
        duration_ms: Date.now() - start,
      };
    }
    if (collection.length > LOOP_ITERATION_CAP) {
      logger.warn({
        module: "execution",
        action: "step.loop.cap_exceeded",
        step_id: p.step.id,
        collection_size: collection.length,
        cap: LOOP_ITERATION_CAP,
      });
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "loop_iteration_cap",
          message: `loop input ${collection.length} exceeds cap ${LOOP_ITERATION_CAP}`,
        },
      };
    }
    return {
      status: "succeeded",
      output: collection,
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      status: "failed",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: {
        code: "loop_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
