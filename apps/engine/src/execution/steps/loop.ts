import { logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { extractStepIdReferences, suggestClosest } from "../../workflows/levenshtein.ts";
import type { LoopStep } from "../../workflows/types.ts";
import { buildJsonataBindings, resolveScopeForJsonata } from "../jsonata-bindings.ts";
import { evaluate as evaluateJsonata } from "../jsonata-engine.ts";
import { applySelector } from "../selectors.ts";
import type { StepResult, StepRunContext } from "../types.ts";
import { buildStepErrorDetail } from "./error-detail.ts";

export const LOOP_ITERATION_CAP = 10_000;

export async function runLoopStep(p: {
  ctx: StepRunContext;
  step: LoopStep;
  scope: Record<string, unknown>;
}): Promise<StepResult> {
  const start = Date.now();
  return instrument({
    module: "execution",
    action: "loop",
    memory: true,
    fields: { step_id: p.step.id },
    fn: () => runLoopBody(p, start),
  });
}

async function runLoopBody(
  p: {
    ctx: StepRunContext;
    step: LoopStep;
    scope: Record<string, unknown>;
  },
  start: number,
): Promise<StepResult> {
  try {
    p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
    let collection: unknown;
    if (p.step.data_selector !== undefined) {
      const wrapped = `const __selector__ = (${p.step.data_selector}); return __selector__(input.scope);`;
      try {
        const out = await runJs({
          code: wrapped,
          input: { scope: p.scope },
          limits: { wall_ms: 5_000 },
          clock: {
            now_ms: p.ctx.started_at.getTime(),
            seed: `${p.ctx.evaluation_seed ?? p.ctx.execution_id}:${p.step.id}`,
          },
          signal: p.ctx.signal,
        });
        collection = (out as { output: unknown }).output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const propMatch =
          msg.match(/cannot read propert(?:y|ies) '([\w_-]+)' of undefined/i) ??
          msg.match(/cannot read propert(?:y|ies) of undefined\s+\(reading '([\w_-]+)'\)/i);
        const badKey = propMatch?.[1] ?? null;
        const scopeKeys = Object.keys(p.scope).filter((k) => !k.startsWith("$"));
        const suggestions = badKey ? suggestClosest(badKey, scopeKeys, 3) : [];
        return {
          status: "failed",
          retry_count: 0,
          duration_ms: Date.now() - start,
          error: {
            code: "data_selector_error",
            message: `Data selector failed: ${msg}${
              suggestions.length > 0
                ? ` (did you mean: ${suggestions.map((s) => `\`${s}\``).join(", ")})`
                : ""
            }`,
            details: {
              data_selector: p.step.data_selector,
              available_scope_keys: scopeKeys.slice(0, 16),
              ...(badKey ? { bad_key: badKey } : {}),
              ...(suggestions.length > 0
                ? { did_you_mean: [{ from: badKey ?? "(unknown)", to: suggestions }] }
                : {}),
            },
          },
        };
      }
    } else if (p.step.over !== undefined) {
      if (p.step.over.startsWith("$.") || p.step.over === "$") {
        collection = applySelector(p.step.over, p.scope);
      } else {
        const bindings = buildJsonataBindings(p.scope, (p.scope as { $input?: unknown }).$input);
        collection = await evaluateJsonata(p.step.over, p.scope, {
          ...bindings,
          clock: {
            now_ms: p.ctx.started_at.getTime(),
            ...(p.ctx.evaluation_seed ? { seed: p.ctx.evaluation_seed } : {}),
          },
        });
      }
    } else {
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
      const observedType =
        collection === null || collection === undefined
          ? "undefined/null"
          : typeof collection === "object"
            ? "object (not array)"
            : typeof collection;
      const scopeKeys = Object.keys(p.scope).slice(0, 8);
      const stepIds = scopeKeys.filter((k) => !k.startsWith("$"));
      const sourceText = p.step.data_selector ?? p.step.over ?? "";
      const referenced = extractStepIdReferences(sourceText);
      const didYouMean: Array<{ from: string; to: string[] }> = [];
      for (const ref of referenced) {
        if (!stepIds.includes(ref)) {
          const matches = suggestClosest(ref, stepIds, 3);
          if (matches.length > 0) didYouMean.push({ from: ref, to: matches });
        }
      }
      const firstMatch = didYouMean[0];
      const sampleStep = firstMatch?.to[0] ?? stepIds[0];
      const hint = sampleStep
        ? firstMatch
          ? ` Did you mean \`$scope.${sampleStep}.data\` (closest match for \`${firstMatch.from}\`)? Confirm the upstream step's output shape with inspect_workflow_draft.`
          : ` Try \`$scope.${sampleStep}.data\` (or the equivalent bare form \`${sampleStep}.data\`) and confirm the upstream step's output shape with inspect_workflow_draft.`
        : " Verify the upstream step's actual output shape with inspect_workflow_draft.";
      return {
        status: "succeeded",
        output: [],
        retry_count: 0,
        duration_ms: Date.now() - start,
        warnings: [
          {
            code: "loop_over_unresolved" as const,
            identifier: p.step.id,
            message: `loop "${p.step.id}" source expression \`${p.step.data_selector ?? p.step.over}\` resolved to ${observedType} — expected an array. The loop produced 0 iterations. Available scope keys: ${scopeKeys.join(", ")}. Every step output is uniformly enveloped at \`$scope.<step>.data.<field>\`.${hint}`,
            details: {
              ...(p.step.data_selector !== undefined
                ? { data_selector: p.step.data_selector }
                : { over: p.step.over }),
              resolved_type: observedType,
              available_scope_keys: scopeKeys,
              ...(sampleStep
                ? {
                    suggested_paths: [`$scope.${sampleStep}.data`, `${sampleStep}.data`],
                  }
                : {}),
              ...(didYouMean.length > 0 ? { did_you_mean: didYouMean } : {}),
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
      error: buildStepErrorDetail({ code: "loop_error", err }),
    };
  }
}
