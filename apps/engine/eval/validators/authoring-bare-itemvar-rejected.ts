// Authoring scenario (Fix E / CI mode): item_var retirement (Fix B).
// The authoring surface accepts exactly ONE loop-item addressing form —
// `$item` (plus `$loop_index`) in JSONata. Pinned here on the
// conversations verifier (the gate `build_workflow` / the pipeline run
// before a draft is accepted):
//
//   - a loop-body JSONata expression that references the iteration
//     item by a bare name is rejected with `bare_iteration_identifier`
//     and a concrete `$item` rewrite as did_you_mean,
//   - declaring `item_var` itself is rejected as a retired field
//     (`item_var_retired`).

import { verifyWorkflow } from "../../src/conversations/verifier.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  bare_item_workflow: { steps: Array<Record<string, unknown>> };
  item_var_workflow: { steps: Array<Record<string, unknown>> };
  expect: {
    bare_error_code: string;
    retired_error_code: string;
    did_you_mean_contains: string;
  };
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;

  // Bare `item` reference inside a loop body → rejected, with `$item`.
  const bareReport = verifyWorkflow(input.bare_item_workflow);
  const bareError = bareReport.errors.find((e) => e.code === input.expect.bare_error_code);
  if (!bareError) {
    return {
      pass: false,
      reason: `expected ${input.expect.bare_error_code} for the bare item reference; got ${JSON.stringify(
        bareReport.errors.map((e) => e.code),
      )}`,
    };
  }
  if (!bareError.message.includes(input.expect.did_you_mean_contains)) {
    return {
      pass: false,
      reason: `bare-iteration error does not point at ${input.expect.did_you_mean_contains}: ${bareError.message}`,
    };
  }

  const itemVarReport = verifyWorkflow(input.item_var_workflow);
  const retired = itemVarReport.errors.find((e) => e.code === input.expect.retired_error_code);
  if (!retired) {
    return {
      pass: false,
      reason: `expected ${input.expect.retired_error_code} for the declared item_var; got ${JSON.stringify(
        itemVarReport.errors.map((e) => e.code),
      )}`,
    };
  }

  return { pass: true };
}
