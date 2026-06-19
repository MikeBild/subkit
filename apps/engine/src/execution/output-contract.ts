// Workflow output contract (Fix 11, sessions 2026-06-11/12 post-mortem).
//
// A workflow definition may declare `output_schema` — a JSON Schema for
// the FINAL workflow output (post `output_transform` / response
// filters). This module is the single validator both surfaces share:
//
//   - `dry_run_workflow` validates the preview output; a violation is a
//     blocking repair warning (the preview is not green, auto-commit is
//     refused) so the authoring loop has a mechanical "done" signal.
//   - the live execution engine validates the final output and attaches
//     a NON-blocking `output_contract_violation` warning to the run
//     result — a live run never fails because the contract drifted.
//
// Ajv config is strict-but-lenient: `strict: false` tolerates unknown
// keywords (LLM-authored schemas routinely carry `examples`, `title`,
// vendor extensions), `allErrors: true` reports every field-level path
// in one pass, and format assertions are off (no ajv-formats dep — a
// format the validator can't check must not fail the contract).
//
// A fresh Ajv instance per call keeps the module state-free: Ajv
// registers schemas by `$id` on compile, so a shared instance would
// throw "schema already exists" the second time the same `$id` is
// compiled. Workflow runs compile at most one schema each; the
// instantiation cost is noise next to the run itself.

import Ajv, { type ValidateFunction } from "ajv";

function freshAjv(): Ajv {
  return new Ajv({ strict: false, allErrors: true, validateFormats: false });
}

export interface OutputContractViolation {
  /** Field-level path into the final output, rooted at `$output`
   *  (e.g. `$output/items/0/name`). */
  path: string;
  message: string;
}

export type OutputContractCheck =
  | { ok: true; valid: true }
  | { ok: true; valid: false; violations: OutputContractViolation[] }
  /** The schema itself did not compile — an authoring bug, not an
   *  output bug. The validator gate should have refused it. */
  | { ok: false; schema_error: string };

/** Compile-only sanity check used by the workflow validator: an
 *  `output_schema` that Ajv cannot compile must never reach a run. */
export function compileOutputContractSchema(
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  try {
    freshAjv().compile(schema);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Validate a final workflow output against the declared contract,
 *  returning every field-level violation path. */
export function checkOutputContract(
  value: unknown,
  schema: Record<string, unknown>,
): OutputContractCheck {
  let validate: ValidateFunction;
  try {
    validate = freshAjv().compile(schema);
  } catch (err) {
    return { ok: false, schema_error: err instanceof Error ? err.message : String(err) };
  }
  if (validate(value)) return { ok: true, valid: true };
  const violations: OutputContractViolation[] = (validate.errors ?? []).map((e) => {
    // For `required` errors Ajv points instancePath at the PARENT
    // object; append the missing property so the path names the field
    // the author has to produce.
    const missing =
      e.keyword === "required" &&
      typeof (e.params as { missingProperty?: unknown }).missingProperty === "string"
        ? `/${(e.params as { missingProperty: string }).missingProperty}`
        : "";
    return {
      path: `$output${e.instancePath}${missing}`,
      message: e.message ?? "violates output_schema",
    };
  });
  return { ok: true, valid: false, violations };
}

/** One-line summary for warning messages / preview summaries:
 *  `"$output/total: must be number; $output/items: required property"`. */
export function summarizeViolations(
  violations: ReadonlyArray<OutputContractViolation>,
  max = 5,
): string {
  const head = violations
    .slice(0, max)
    .map((v) => `${v.path}: ${v.message}`)
    .join("; ");
  const rest = violations.length > max ? `; +${violations.length - max} more` : "";
  return `${head}${rest}`;
}
