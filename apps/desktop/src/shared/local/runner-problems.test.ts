import { describe, expect, test } from "bun:test";
import {
  EMPTY_PROBLEM_FOLD,
  errorClassOf,
  foldProblem,
  PROBLEM_FOLD_MS,
  type ProblemEvent,
  type ProblemFold,
  problemLine,
  type RunnerProblem,
  RunnerProblemSchema,
} from "./runner-problems.ts";

const claim503: ProblemEvent = { scope: "claim", error_class: "http", status: 503 };
const offline: ProblemEvent = { scope: "delivery", error_class: "network", status: null };

function run(events: readonly [ProblemEvent, number][]): RunnerProblem[] {
  let fold: ProblemFold = EMPTY_PROBLEM_FOLD;
  const emitted: RunnerProblem[] = [];
  for (const [event, at] of events) {
    const next = foldProblem(fold, event, at);
    fold = next.fold;
    if (next.emit) emitted.push(next.emit);
  }
  return emitted;
}

describe("foldProblem", () => {
  test("reports the first failure at once", () => {
    expect(run([[claim503, 0]])).toEqual([{ ...claim503, repeats: 0 }]);
  });

  test("folds repeats inside the window and names their count with the next entry", () => {
    const emitted = run([
      [claim503, 0],
      [claim503, 1_000],
      [claim503, 2_000],
      [claim503, PROBLEM_FOLD_MS],
    ]);
    expect(emitted).toEqual([
      { ...claim503, repeats: 0 },
      { ...claim503, repeats: 2 },
    ]);
  });

  test("keeps different scopes, classes and statuses apart", () => {
    const emitted = run([
      [claim503, 0],
      [offline, 1],
      [{ ...claim503, status: 500 }, 2],
      [claim503, 3],
    ]);
    expect(emitted.map((problem) => problem.status)).toEqual([503, null, 500]);
  });
});

describe("errorClassOf", () => {
  test("sorts errors into classes without their message", () => {
    expect(errorClassOf({ name: "Error", status: 502 })).toBe("http");
    expect(errorClassOf({ name: "TypeError", status: null })).toBe("network");
    expect(errorClassOf({ name: "SyntaxError", status: null })).toBe("invalid_answer");
    expect(errorClassOf({ name: "ZodError", status: null })).toBe("invalid_answer");
    expect(errorClassOf({ name: "RangeError", status: null })).toBe("unexpected");
  });
});

describe("problemLine", () => {
  test("says what failed and how often", () => {
    expect(problemLine({ ...claim503, repeats: 0 })).toBe("http 503 failed");
    expect(problemLine({ ...offline, repeats: 4 })).toBe(
      "network failed, 4 more times since the last entry",
    );
  });

  test("round-trips through the wire schema", () => {
    const problem = { ...claim503, repeats: 1 };
    expect(RunnerProblemSchema.parse(problem)).toEqual(problem);
  });
});
