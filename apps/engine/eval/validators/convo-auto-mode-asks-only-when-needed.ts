import {
  type CoverEvalInput,
  gradeEvalCase,
} from "../../src/conversations/instruction-cover/eval-cases.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as CoverEvalInput;
  const outcomes = input.cases.map((item) => gradeEvalCase(input, item));
  const needless = outcomes.filter((outcome) => outcome.failure === "needless_ask");
  const wrong = outcomes.filter((outcome) => outcome.failure === "ran_without_asking");
  const metrics = {
    cases: outcomes.length,
    expected_run: outcomes.filter((outcome) => outcome.expect === "run").length,
    expected_ask: outcomes.filter((outcome) => outcome.expect === "ask").length,
    needless_asks: needless.length,
    ran_without_asking: wrong.length,
  };
  if (needless.length === 0 && wrong.length === 0) return { pass: true, metrics };
  const describe = (label: string, failed: typeof outcomes) =>
    failed.length === 0
      ? []
      : [`${label}: ${failed.map((o) => `${o.id}${o.reason ? ` (${o.reason})` : ""}`).join(", ")}`];
  return {
    pass: false,
    metrics,
    reason: [
      ...describe("asked although the person's words cover the action", needless),
      ...describe("ran without asking", wrong),
    ].join("; "),
  };
}
