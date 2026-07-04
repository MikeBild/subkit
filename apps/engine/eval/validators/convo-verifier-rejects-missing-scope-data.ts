import { verifyWorkflow } from "../../src/conversations/verifier.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  workflow: {
    steps: Array<Record<string, unknown>>;
  };
  expect_error_code: string;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const report = verifyWorkflow(input.workflow);
  if (!report.errors.some((e) => e.code === input.expect_error_code)) {
    return {
      pass: false,
      reason: `expected error code '${input.expect_error_code}' not found; got ${JSON.stringify(
        report.errors.map((e) => e.code),
      )}`,
    };
  }
  return { pass: true };
}
