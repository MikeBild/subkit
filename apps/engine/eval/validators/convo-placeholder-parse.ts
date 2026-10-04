import { parsePlaceholders } from "../../src/llm/substitution/parser.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  text: string;
  expect_kinds: string[];
  expect_errors?: number;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const { tokens, errors } = parsePlaceholders(input.text);
  const kinds = tokens.map((t) => t.kind).sort();
  const expected = [...input.expect_kinds].sort();
  if (kinds.length !== expected.length || !kinds.every((k, i) => k === expected[i])) {
    return {
      pass: false,
      reason: `expected kinds ${JSON.stringify(expected)} got ${JSON.stringify(kinds)}`,
    };
  }
  const expectedErrors = input.expect_errors ?? 0;
  if (errors.length !== expectedErrors) {
    return {
      pass: false,
      reason: `expected ${expectedErrors} errors, got ${errors.length}`,
    };
  }
  return { pass: true };
}
