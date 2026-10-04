import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { extractStepIdReferences, suggestClosest } from "../workflows/levenshtein.ts";
import type { StepResult } from "./types.ts";

export function buildLoopChildScope(
  scope: Record<string, unknown>,
  item: unknown,
  itemIdx: number,
): Record<string, unknown> {
  return {
    ...scope,
    $item: item,
    $loop_index: itemIdx,
  };
}

export async function resolveForEachCollection(
  forEachSelector: string,
  stepId: string,
  scope: Record<string, unknown>,
  start: number,
  clock: { now_ms: number; seed: string } | null,
): Promise<
  | { kind: "collection"; items: unknown[] }
  | { kind: "failure"; result: StepResult }
  | { kind: "empty_warning"; result: StepResult }
> {
  const wrapped = `const __selector__ = (${forEachSelector}); return __selector__(input.scope);`;
  let collection: unknown;
  try {
    const out = await runJs({
      code: wrapped,
      input: { scope },
      limits: { wall_ms: 5_000 },
      clock,
    });
    collection = (out as { output: unknown }).output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const propMatch =
      msg.match(/cannot read propert(?:y|ies) '([\w_-]+)' of undefined/i) ??
      msg.match(/cannot read propert(?:y|ies) of undefined\s+\(reading '([\w_-]+)'\)/i);
    const badKey = propMatch?.[1] ?? null;
    const scopeKeys = Object.keys(scope).filter((k) => !k.startsWith("$"));
    const suggestions = badKey ? suggestClosest(badKey, scopeKeys, 3) : [];
    return {
      kind: "failure",
      result: {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "for_each_selector_error",
          message: `for_each selector failed: ${msg}${
            suggestions.length > 0
              ? ` (did you mean: ${suggestions.map((s) => `\`${s}\``).join(", ")})`
              : ""
          }. A for_each selector is a JavaScript arrow function over the run scope: \`(sourceData) => sourceData.<step_id>.data.<array_path>\`.`,
          details: {
            for_each: forEachSelector,
            available_scope_keys: scopeKeys.slice(0, 16),
            ...(badKey ? { bad_key: badKey } : {}),
            ...(suggestions.length > 0
              ? { did_you_mean: [{ from: badKey ?? "(unknown)", to: suggestions }] }
              : {}),
          },
        },
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
    const scopeKeys = Object.keys(scope).slice(0, 8);
    const stepIds = scopeKeys.filter((k) => !k.startsWith("$"));
    const sourceText = forEachSelector;
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
        : ` Try \`(sourceData) => sourceData.${sampleStep}.data\` and confirm the upstream step's output shape with inspect_workflow_draft.`
      : " Verify the upstream step's actual output shape with inspect_workflow_draft.";
    return {
      kind: "empty_warning",
      result: {
        status: "succeeded",
        output: [],
        retry_count: 0,
        duration_ms: Date.now() - start,
        warnings: [
          {
            code: "loop_over_unresolved" as const,
            identifier: stepId,
            message: `for_each step "${stepId}" selector \`${forEachSelector}\` resolved to ${observedType} — expected an array. The step produced 0 iterations. Available scope keys: ${scopeKeys.join(", ")}. Every step output is uniformly enveloped at \`$scope.<step>.data.<field>\`.${hint}`,
            details: {
              for_each: forEachSelector,
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
      },
    };
  }

  const FOR_EACH_ITERATION_CAP = 10_000;
  if (collection.length > FOR_EACH_ITERATION_CAP) {
    return {
      kind: "failure",
      result: {
        status: "failed",
        retry_count: 0,
        duration_ms: Date.now() - start,
        error: {
          code: "loop_iteration_cap",
          message: `for_each input ${collection.length} exceeds cap ${FOR_EACH_ITERATION_CAP}`,
        },
      },
    };
  }

  return { kind: "collection", items: collection };
}
