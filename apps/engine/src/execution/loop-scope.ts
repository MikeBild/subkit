// Loop-iteration scope construction — extracted from engine.ts so the
// binding contract has a single owner with focused tests. The canonical
// loop-item bindings are `$item` + `$loop_index`; the bare `item_var`
// name is a per-definition contract: it is bound ONLY when the stored
// definition explicitly declares `item_var` (legacy versions executed
// via version_id keep running unchanged), and new/migrated definitions
// omit the field and address the item as `$item` exclusively.
//
// This conditional binding is a versioned stored-data contract keyed on
// the stored definition — NOT a compatibility flag. A definition
// without `item_var` that references a bare iteration name gets the
// runtime `unresolved_identifier` warning instead of a silent empty
// result, which is exactly the signal the authoring loop repairs from.
//
// `resolveForEachCollection` is the shared collection-resolver for the
// `for_each` per-step inline iteration path. It reuses the runJs path
// and the typed `did_you_mean` diagnostics from `steps/loop.ts` so
// the two paths (legacy `loop` kind + new `for_each` inline) share a
// single implementation.

import { runJs } from "../sandboxes/quickjs/runtime.ts";
import { extractStepIdReferences, suggestClosest } from "../workflows/levenshtein.ts";
import type { LoopStep } from "../workflows/types.ts";
import type { StepResult } from "./types.ts";

export function buildLoopChildScope(
  loopStep: Pick<LoopStep, "item_var">,
  scope: Record<string, unknown>,
  item: unknown,
  itemIdx: number,
): Record<string, unknown> {
  const declared = typeof loopStep.item_var === "string" && loopStep.item_var.length > 0;
  return {
    ...scope,
    ...(declared ? { [loopStep.item_var as string]: item } : {}),
    $item: item,
    $loop_index: itemIdx,
  };
}

/**
 * Resolve a `for_each` JS selector string into an array of items.
 *
 * Returns `{ kind: "collection", items: unknown[] }` on success, or
 * `{ kind: "failure", result: StepResult }` when the selector throws,
 * resolves to a non-array, or would exceed the iteration cap.
 *
 * Mirrors the `data_selector` resolution in `steps/loop.ts` including
 * the `did_you_mean` diagnostics — shared rather than duplicated.
 */
export async function resolveForEachCollection(
  forEachSelector: string,
  stepId: string,
  scope: Record<string, unknown>,
  start: number,
  // Deterministic clock/id context for `sk.now()`/`sk.uuid()` inside the
  // selector — mirrors how `steps/transform.ts` wires the execution's
  // fixed `started_at` and a per-scope seed. Required-with-explicit-null
  // (same contract as `RunJsOptions.clock`): a real execution passes the
  // clock; a pure lint/preview caller passes `null` to opt into the
  // constant-epoch case. Making it required keeps a forgotten wiring a
  // COMPILE error instead of a silent epoch read at runtime.
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
    // did_you_mean: same error-message pattern matching as loop.ts data_selector path.
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
