import { classifyProviderError } from "../../src/llm/provider-errors.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export function validate(fixture: FixtureRecord): ValidationResult {
  const { cases } = fixture.input as {
    cases: Array<{ err: unknown; expect: string }>;
  };
  const failures: string[] = [];
  for (const c of cases) {
    const got = classifyProviderError(c.err);
    if (got !== c.expect) {
      failures.push(`${JSON.stringify(c.err)} → ${got} (expected ${c.expect})`);
    }
  }
  if (failures.length > 0) {
    return { pass: false, reason: `mismatches: ${failures.join("; ")}` };
  }
  return { pass: true, metrics: { cases: cases.length } };
}
