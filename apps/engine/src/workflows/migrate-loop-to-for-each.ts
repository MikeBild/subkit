// One-shot rewriter for active stored workflow definitions: converts
// `kind:"loop"` steps to per-step `for_each` on the single body step.
//
// Eligibility rules (conservative — ineligible workflows stay on the
// legacy loop execution path unchanged):
//
//   1. Loop has exactly ONE body step (multi-body loops are structurally
//      complex — the body steps execute as a sequential mini-pipeline
//      per item, and there is no direct `for_each` equivalent).
//   2. Loop has `data_selector` (JS arrow fn already) OR `over`
//      (JSONata path that can be wrapped as a JS arrow fn).
//      `over` strings that look like JSONata expressions (contain `$`,
//      operators, or whitespace that isn't a plain dot-path) are left
//      on the legacy path.
//   3. No other step (outside the loop body) references the loop step's
//      ID in any string, expression, or data_selector — the scope key
//      changes from loop_id to body_step_id and downstream references
//      would break. The check is conservative: a hit anywhere in a
//      non-body step's JSON serialization aborts the migration for that
//      workflow.
//   4. The body step does not already have `for_each` set.
//   5. The rewritten definition passes `validateWorkflowDef`.
//
// The equivalence guarantee from the estate JS migration (Fix H in the
// approved plan) is realised here as rules 3–5: structural equivalence
// is proven by (a) absence of any downstream reference to the now-
// removed loop step — including in workflow-root fields such as
// `output_transform`, `output_transform_function`, `validation_function`,
// and `output_schema` — and (b) the new definition passing the same
// validation gate that would have rejected it at authoring time. No
// live dry-run output comparison is performed; the check is purely
// structural (conservative: any hit on the loop step id in any field
// aborts the migration for that loop).
//
// Pure data — no I/O, no DB, no LLM.

import type { LoopStep, StepDef, WorkflowDef } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

export interface LoopToForEachChange {
  loop_step_id: string;
  body_step_id: string;
  /** The JS arrow-function string placed in `for_each`. */
  for_each: string;
  /** Original `over` or `data_selector` value before conversion. */
  original_selector: string;
  selector_source: "data_selector" | "over";
}

export type WorkflowLoopToForEachRewrite =
  | { ok: true; changed: boolean; def: WorkflowDef; changes: LoopToForEachChange[] }
  | { ok: false; reason: string; loop_step_id?: string };

// Plain dot-path: alphanumeric segments separated by dots, optionally
// followed by `[N]` bracket indexers. A step id alone is also accepted.
// Anything with a `$`, whitespace, operators, or open-paren is a
// JSONata expression — we cannot wrap it safely without understanding
// the expression's binding semantics.
const PLAIN_DOT_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*$/;

/**
 * Convert a loop `over` string to a JS `for_each` arrow function body.
 *
 * Accepts only plain dot-path forms — e.g. `fetch_data.data.items`.
 * Returns null when the `over` value looks like a JSONata expression
 * (contains `$`, `~>`, operators, or spaces) that cannot be trivially
 * converted. Those loops are left on the legacy path.
 */
function overToForEach(over: string): string | null {
  const trimmed = over.trim();
  if (!PLAIN_DOT_PATH_RE.test(trimmed)) return null;
  // Wrap as a JS arrow function reading from `sourceData` (the scope).
  return `(sourceData) => sourceData.${trimmed}`;
}

/**
 * Check whether a step that is NOT a member of `bodyIds` references
 * `loopStepId` anywhere in its serialized JSON. A hit means the downstream
 * consumer reads the loop's aggregate scope key and the migration would
 * break it.
 */
function stepReferencesLoopId(step: StepDef, loopStepId: string): boolean {
  const hay = JSON.stringify(step);
  // Match the bare id as a word boundary or as a key/string literal.
  // Conservative: any occurrence aborts the migration.
  return hay.includes(loopStepId);
}

/**
 * Rewrite eligible `loop` steps in `def` to per-step `for_each` on the
 * single body step. Ineligible loops are left unchanged.
 *
 * Pure: the input `def` is never mutated. Returns `ok: false` only for
 * hard structural errors (e.g. the body step does not exist). Per-loop
 * eligibility failures return `ok: true` with `changed: false` and an
 * empty `changes[]`.
 */
export function rewriteLoopsToForEach(def: WorkflowDef): WorkflowLoopToForEachRewrite {
  const loops = def.steps.filter((s): s is LoopStep => s.kind === "loop");
  if (loops.length === 0) {
    return { ok: true, changed: false, def, changes: [] };
  }

  const changes: LoopToForEachChange[] = [];
  // Build a mutable clone as a plain object; we'll mutate it step-by-step.
  const outSteps: StepDef[] = def.steps.map((s) => ({ ...s }) as StepDef);
  // Track loop step ids to remove after processing.
  const loopStepIdsToRemove = new Set<string>();

  for (const loop of loops) {
    // Rule 1: single body step.
    if (loop.body.length !== 1) continue;
    const bodyStepId = loop.body[0];
    if (!bodyStepId) continue;

    // Rule 2: determine the for_each expression.
    let forEachExpr: string | null;
    let selectorSource: "data_selector" | "over";
    if (loop.data_selector !== undefined) {
      // Already a JS arrow function — use directly.
      forEachExpr = loop.data_selector;
      selectorSource = "data_selector";
    } else if (loop.over !== undefined) {
      forEachExpr = overToForEach(loop.over);
      if (forEachExpr === null) continue; // complex JSONata `over` — leave on legacy path
      selectorSource = "over";
    } else {
      // Neither set — schema invariant violation; skip.
      continue;
    }

    // Rule 3: no non-body step references the loop step id, AND no
    // workflow-root field references it either. Root fields that embed
    // scope references by step id:
    //   - output_transform (JSONata, may contain `$scope.<loop_id>`)
    //   - output_transform_function (JS, same)
    //   - validation_function (JS, same)
    //   - output_schema (JSON Schema, may contain step-id refs in descriptions)
    // If any of these contain the loop step id the migration would silently
    // produce wrong/empty output because the scope key changes from
    // `loop_id` to `body_step_id` after rewrite.
    const bodyIdSet = new Set(loop.body);
    const hasStepRef = def.steps.some(
      (s) => s.id !== loop.id && !bodyIdSet.has(s.id) && stepReferencesLoopId(s, loop.id),
    );
    const rootFieldsHay = [
      def.output_transform,
      def.output_transform_function,
      def.validation_function,
      def.output_schema !== undefined ? JSON.stringify(def.output_schema) : undefined,
    ]
      .filter((v): v is string => typeof v === "string")
      .join("\0");
    const hasRootRef = rootFieldsHay.includes(loop.id);
    if (hasStepRef || hasRootRef) continue;

    // Rule 4: body step must exist and not already have for_each.
    const bodyStepIndex = outSteps.findIndex((s) => s.id === bodyStepId);
    if (bodyStepIndex === -1) {
      return {
        ok: false,
        reason: `loop body step "${bodyStepId}" not found in workflow steps`,
        loop_step_id: loop.id,
      };
    }
    const bodyStep = outSteps[bodyStepIndex];
    if (!bodyStep) continue;
    if ((bodyStep as { for_each?: string }).for_each !== undefined) continue;

    // Apply: set for_each on the body step, mark loop for removal.
    outSteps[bodyStepIndex] = { ...bodyStep, for_each: forEachExpr } as StepDef;
    loopStepIdsToRemove.add(loop.id);
    changes.push({
      loop_step_id: loop.id,
      body_step_id: bodyStepId,
      for_each: forEachExpr,
      original_selector: loop.data_selector ?? loop.over ?? "",
      selector_source: selectorSource!,
    });
  }

  if (changes.length === 0) {
    return { ok: true, changed: false, def, changes: [] };
  }

  // Remove the converted loop steps.
  const filteredSteps = outSteps.filter((s) => !loopStepIdsToRemove.has(s.id));

  const newDef: WorkflowDef = { ...def, steps: filteredSteps };

  // Rule 5: the rewritten definition must pass validateWorkflowDef.
  const validation = validateWorkflowDef(newDef);
  if (!validation.ok || !validation.workflow) {
    return {
      ok: false,
      reason: `rewritten definition failed validation: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    };
  }

  return { ok: true, changed: true, def: validation.workflow, changes };
}
