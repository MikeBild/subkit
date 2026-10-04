// Derived "what is the public output of this workflow?" label.
//
// The engine returns the last step's `scope_value` on `RunResult.output`
// when no transform is declared (verified at
// `apps/engine/src/execution/engine.ts:854` and surfaced through the
// run-workflow tool at
// `apps/engine/src/conversations/tools/engine-api/writes/run-workflow.ts:545`).
// That contract is invisible to a reader of the workflow JSON — they
// see `output_transform: null` and naturally infer "output is null."
// Polish A surfaces an explicit `output_behavior` label so the LLM
// (and any operator UI consuming `inspect_workflow`) sees what the
// public output WILL be without re-reading the engine code.
//
// Lives in the workflow domain (not under conversations/tools/) so the
// CLI preview, `diagnose_latest_execution`, and any future surface can
// import the same derivation. Adding a new case (e.g. a fourth
// output-shaping branch in the engine) requires updating both this
// helper AND the engine — keep them in sync.

export type OutputBehavior = "explicit_transform" | "transform_function" | "last_step_passthrough";

interface OutputBehaviorInput {
  output_transform?: unknown;
  output_transform_function?: unknown;
}

/**
 * Derive the `output_behavior` label from the workflow definition's
 * declared transform fields. The engine's branches at
 * `execution/engine.ts:597-642` map 1:1 to the cases here:
 *
 *   - `output_transform` set   → engine evaluates the JSONata against
 *                                `lastOutput` → `explicit_transform`.
 *   - `output_transform_function` set → engine runs the JS in QuickJS
 *                                       against `lastOutput` →
 *                                       `transform_function`.
 *   - neither set              → engine emits `lastOutput` as-is →
 *                                `last_step_passthrough`.
 */
export function deriveOutputBehavior(def: OutputBehaviorInput): OutputBehavior {
  if (def.output_transform) return "explicit_transform";
  if (def.output_transform_function) return "transform_function";
  return "last_step_passthrough";
}
