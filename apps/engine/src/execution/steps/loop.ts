// Loop step. Iterates the configured collection. Hard cap 10,000.
// In P3 we only support a `transform`-shaped body via JSONata —
// engine.ts will call this driver and merge the results array.

import { logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { extractStepIdReferences, suggestClosest } from "../../workflows/levenshtein.ts";
import type { LoopStep } from "../../workflows/types.ts";
import { buildJsonataBindings, resolveScopeForJsonata } from "../jsonata-bindings.ts";
import { compile as compileJsonata } from "../jsonata-engine.ts";
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
    // A loop's `over` / `data_selector` is a downstream consumer of the
    // scope — a nested loop can iterate a prior loop's output. Re-hydrate
    // any `OffloadRef`s an upstream loop spilled so the collection
    // resolves to a real array; no-op when nothing was offloaded.
    p.scope = await resolveScopeForJsonata(p.ctx.db, p.ctx.tenant_id, p.scope, p.ctx.signal);
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
          // Deterministic clock/id for `sk.now()`/`sk.uuid()` in the
          // selector — the execution's fixed `started_at` + a per-step
          // seed, same wiring as steps/transform.ts. Without it an author
          // calling `sk.now()` in a data_selector silently gets the epoch.
          clock: {
            now_ms: p.ctx.started_at.getTime(),
            seed: `${p.ctx.execution_id}:${p.step.id}`,
          },
        });
        collection = (out as { output: unknown }).output;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // did_you_mean post-processing for the dominant
        // data_selector failure: `Cannot read property 'X' of
        // undefined` / `Cannot read properties of undefined (reading 'X')`.
        // The LLM commonly writes `(data) => data.fetch_projects.…`
        // when the actual scope key is `fetch_project` — without the
        // suggestion the QuickJS message is opaque.
        // Two error message shapes in the wild:
        //   QuickJS / older SpiderMonkey: "cannot read property 'X' of undefined"
        //   modern V8 / Node:             "Cannot read properties of undefined (reading 'X')"
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
        // Bind `$input`, `$scope`, `$steps`, and unpacked `$<key>`
        // entries so the loop's `over` expression honors the same
        // skill-documented `$scope.<id>.data` contract every other
        // author-written JSONata site does.
        const bindings = buildJsonataBindings(p.scope, (p.scope as { $input?: unknown }).$input);
        collection = await compileJsonata(p.step.over).evaluate(p.scope, bindings);
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
      // Concrete suggestion for the LLM: pick the first non-`$`
      // scope key as a stand-in and emit BOTH equivalent forms
      // (`$scope.<id>.data` and bare `<id>.data`) so the next
      // attempt converges. Pre-fix the LLM cycled through path
      // variants because the message only said "uniformly
      // enveloped" without giving a concrete path to try.
      const stepIds = scopeKeys.filter((k) => !k.startsWith("$"));
      // did_you_mean — extract referenced step ids from the source
      // expression and Levenshtein-match them against the actual
      // scope keys. Pre-fix the warning listed every available scope
      // key but never named the typo; the LLM had to do the diff
      // itself. With this match in place the very first retry can
      // copy the suggested id verbatim.
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
