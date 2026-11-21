import {
  gradeJobCase,
  type JobEvalInput,
  type JobEvalOutcome,
} from "../../src/conversations/instruction-cover/job-eval-cases.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

function failedSteps(outcomes: readonly JobEvalOutcome[], failure: string): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.steps
      .filter((step) => step.failure === failure)
      .map((step) => `${outcome.id}#${step.index}${step.reason ? ` (${step.reason})` : ""}`),
  );
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as JobEvalInput;
  const outcomes = input.cases.map((item) => gradeJobCase(input, item));
  const steps = outcomes.flatMap((outcome) => outcome.steps);
  const needless = failedSteps(outcomes, "needless_ask");
  const wrong = failedSteps(outcomes, "ran_without_asking");
  const stops = failedSteps(outcomes, "wrong_stop");
  const metrics = {
    cases: outcomes.length,
    steps: steps.length,
    expected_run: steps.filter((step) => step.expect === "run").length,
    expected_ask: steps.filter((step) => step.expect === "ask").length,
    expected_refuse: steps.filter((step) => step.expect === "refuse").length,
    jobs_reaching_result: outcomes.filter((outcome) => outcome.failure === null).length,
    needless_asks: needless.length,
    ran_without_asking: wrong.length,
    wrong_stops: stops.length,
  };
  if (needless.length + wrong.length + stops.length === 0) return { pass: true, metrics };
  const describe = (label: string, failed: readonly string[]) =>
    failed.length === 0 ? [] : [`${label}: ${failed.join(", ")}`];
  return {
    pass: false,
    metrics,
    reason: [
      ...describe("asked inside a covered job", needless),
      ...describe("ran without asking", wrong),
      ...describe("asked instead of refusing or refused instead of asking", stops),
    ].join("; "),
  };
}
