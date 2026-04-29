// Loop step. Iterates the configured collection. Hard cap 10,000.
// In P3 we only support a `transform`-shaped body via JSONata —
// engine.ts will call this driver and merge the results array.

import jsonata from "jsonata";
import { logger } from "../../logging/logger.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
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
    // `data_selector` (JS function form) takes precedence when set.
    // The body is wrapped as `(sourceData) => <body>` so authors can
    // write either a full arrow function or a bare expression. A
    // selector failure is treated as a real exception with the
    // JS-engine message — distinct from the path-style
    // `loop_over_unresolved` warning, because here the author knows
    // they wrote code that didn't compile or threw, and we want the
    // exception to surface verbatim.
    if (p.step.data_selector !== undefined) {
      // runJs evaluates user code as a function body — the host
      // wrapper does `__fn__ = function(input){ <code> }; return __fn__(input)`.
      // Therefore the body must `return` the selector's value
      // explicitly.
      const wrapped = `const __selector__ = (${p.step.data_selector}); return __selector__(input.scope);`;
      try {
        const out = await runJs({
          code: wrapped,
          input: { scope: p.scope },
          limits: { wall_ms: 5_000 },
        });
        collection = (out as { output: unknown }).output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "data_selector_error",
            message: `Data selector failed: ${msg}`,
            details: { data_selector: p.step.data_selector },
          },
        };
      }
    } else if (p.step.over !== undefined) {
      if (p.step.over.startsWith("$.") || p.step.over === "$") {
        collection = applySelector(p.step.over, p.scope);
      } else {
        collection = await jsonata(p.step.over).evaluate(p.scope);
      }
    } else {
      // Schema refine prevents this, but keep a defensive branch.
      return {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "loop_source_missing",
          message: "Loop step must set exactly one of `over` or `data_selector`.",
        },
      };
    }
    if (!Array.isArray(collection)) {
      // `over` resolved to non-array → loop produces no iterations.
      // Pre-fix this returned succeeded with output=[] silently and
      // the LLM had no signal that the path was wrong (session
      // 86de186b: 9× retries with `over: "$scope.X.data.projects"`
      // resolving to undefined produced "Loop body produced no rows"
      // every time but no path-mismatch warning). Surface a typed
      // warning + the actual scope keys so the LLM can correct the
      // path on the very next attempt instead of guessing.
      const observedType =
        collection === null || collection === undefined
          ? "undefined/null"
          : typeof collection === "object"
            ? "object (not array)"
            : typeof collection;
      const scopeKeys = Object.keys(p.scope).slice(0, 8);
      return {
        status: "succeeded",
        output: [],
        retry_count: 0,
        duration_ms: Date.now() - start,
        warnings: [
          {
            code: "loop_over_unresolved" as const,
            identifier: p.step.id,
            message: `loop "${p.step.id}" source expression \`${p.step.data_selector ?? p.step.over}\` resolved to ${observedType} — expected an array. The loop produced 0 iterations. Available scope keys: ${scopeKeys.join(", ")}. Every step output is uniformly enveloped at \`$scope.<step>.data.<field>\`. Verify the upstream step's actual output shape with inspect_workflow.`,
            details: {
              ...(p.step.data_selector !== undefined
                ? { data_selector: p.step.data_selector }
                : { over: p.step.over }),
              resolved_type: observedType,
              available_scope_keys: scopeKeys,
            },
          },
        ],
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
