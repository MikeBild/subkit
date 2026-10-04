import { applyDlpFilters, DEFAULT_DLP_RULES } from "../../src/execution/response-filters.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  payload: unknown;
  expect_redacted_paths: string[];
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const { value, redacted } = applyDlpFilters(input.payload, [...DEFAULT_DLP_RULES]);
  const paths = new Set(redacted.map((r) => r.path));
  for (const req of input.expect_redacted_paths) {
    if (!paths.has(req)) {
      return {
        pass: false,
        reason: `path '${req}' was not redacted; got ${JSON.stringify([...paths])}`,
      };
    }
  }
  const serialised = JSON.stringify(value);
  const CANARIES = ["ada@example.test", "555-010-0199", "123-45-6789"];
  for (const c of CANARIES) {
    if (serialised.includes(c)) {
      return { pass: false, reason: `canary '${c}' leaked into output` };
    }
  }
  return { pass: true };
}
