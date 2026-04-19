// Conversation-quality: verifier catches a scope reference that
// targets a step declared later in the workflow (forward reference).
// This regression gate prevents a class of confusing silent-null
// bugs at run time.

import { verifyWorkflow } from "../../src/conversations/verifier.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  workflow: { steps: Array<Record<string, unknown>> };
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const report = verifyWorkflow(input.workflow);
  if (!report.errors.some((e) => e.code === "scope_ref_unresolved")) {
    return {
      pass: false,
      reason: `expected scope_ref_unresolved; got ${JSON.stringify(
        report.errors.map((e) => e.code),
      )}`,
    };
  }
  return { pass: true };
}
