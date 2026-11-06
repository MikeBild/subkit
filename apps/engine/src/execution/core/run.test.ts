import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  branchArmStepIds,
  continuedStepWarning,
  decideStepFailure,
  findHeldDependency,
  skippedAfterFailure,
  stepErrorOf,
  stopsRunOnFailure,
  untakenArmStepIds,
} from "./run.ts";
import { isTerminalExecutionStatus, STEP_STATUSES } from "./status.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;
const idArb = fc.constantFrom("a", "b", "c", "d");
const edgesArb = fc.array(fc.record({ from: idArb, to: idArb }), { maxLength: 8 });
const errorArb = fc.option(fc.record({ code: fc.string(), message: fc.string() }), {
  nil: undefined,
});

describe("findHeldDependency", () => {
  const dag = {
    edges: [
      { from: "b", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "a" },
      { from: "b", to: "c" },
    ],
  };

  test("returns the first missing edge target of the step", () => {
    expect(findHeldDependency(dag, "b", (id) => id === "a" || id === "c")).toBe("a");
    expect(findHeldDependency(dag, "b", (id) => id === "c")).toBe("c");
  });

  test("ignores self edges and edges of other steps", () => {
    expect(findHeldDependency(dag, "b", (id) => id === "b")).toBeNull();
    expect(findHeldDependency(dag, "d", () => true)).toBeNull();
  });

  test("property: a hit is a missing, non-self edge target of the step", () => {
    fc.assert(
      fc.property(edgesArb, idArb, fc.subarray(["a", "b", "c", "d"]), (edges, step, missing) => {
        const hit = findHeldDependency({ edges }, step, (id) => missing.includes(id));
        if (hit === null)
          expect(
            edges.some((e) => e.from === step && e.to !== step && missing.includes(e.to)),
          ).toBe(false);
        else {
          expect(hit).not.toBe(step);
          expect(missing).toContain(hit);
          expect(edges.some((e) => e.from === step && e.to === hit)).toBe(true);
        }
      }),
      FC,
    );
  });
});

describe("branch arms", () => {
  const branch = { then_steps: ["t1", "t2"], else_steps: ["e1"] };

  test("the taken then arm skips the else arm", () => {
    expect(untakenArmStepIds(branch, { arm: "then" })).toEqual(["e1"]);
  });

  test("any other output skips the then arm", () => {
    expect(untakenArmStepIds(branch, { arm: "else" })).toEqual(["t1", "t2"]);
    expect(untakenArmStepIds(branch, null)).toEqual(["t1", "t2"]);
    expect(untakenArmStepIds(branch, undefined)).toEqual(["t1", "t2"]);
  });

  test("missing arms yield nothing", () => {
    expect(untakenArmStepIds({}, { arm: "then" })).toEqual([]);
    expect(untakenArmStepIds({}, { arm: "else" })).toEqual([]);
    expect(branchArmStepIds({})).toEqual([]);
  });

  test("branchArmStepIds lists then before else", () => {
    expect(branchArmStepIds(branch)).toEqual(["t1", "t2", "e1"]);
  });

  test("property: the untaken arm is always one of the declared arms", () => {
    fc.assert(
      fc.property(
        fc.array(idArb),
        fc.array(idArb),
        fc.option(fc.constantFrom("then", "else", "x"), { nil: undefined }),
        (then_steps, else_steps, arm) => {
          const skipped = untakenArmStepIds({ then_steps, else_steps }, { arm });
          expect(skipped === then_steps || skipped === else_steps).toBe(true);
          expect(branchArmStepIds({ then_steps, else_steps })).toEqual([
            ...then_steps,
            ...else_steps,
          ]);
        },
      ),
      FC,
    );
  });
});

describe("step failure decisions", () => {
  test("stepErrorOf keeps the step error and defaults a missing one", () => {
    const error = { code: "x", message: "y", details: 1 };
    expect(stepErrorOf(error)).toBe(error);
    expect(stepErrorOf(null)).toEqual({ code: "step_failed", message: "step failed" });
  });

  test("on_error defaults to fail", () => {
    expect(stopsRunOnFailure({})).toBe(true);
    expect(stopsRunOnFailure({ on_error: "fail" })).toBe(true);
    expect(stopsRunOnFailure({ on_error: "continue" })).toBe(false);
  });

  test("a failing step stops the run with its terminal status", () => {
    expect(
      decideStepFailure({ id: "s" }, "timed_out", { code: "slow", message: "too slow" }),
    ).toEqual({ kind: "fail", status: "timed_out", error: { code: "slow", message: "too slow" } });
    expect(decideStepFailure({ id: "s", on_error: "fail" }, "failed", null)).toEqual({
      kind: "fail",
      status: "failed",
      error: { code: "step_failed", message: "step failed" },
    });
  });

  test("a continuing step yields the run warning", () => {
    expect(
      decideStepFailure({ id: "s", on_error: "continue" }, "aborted", {
        code: "stop",
        message: "cancelled",
      }),
    ).toEqual({
      kind: "continue",
      warning: {
        code: "step_failed_continued",
        step_key: "s",
        message:
          'step "s" aborted (stop: cancelled) but declares on_error:"continue" — the run continued',
        details: { step_status: "aborted", error_code: "stop" },
      },
    });
  });

  test("continuedStepWarning defaults a missing error", () => {
    expect(continuedStepWarning("b", "failed", undefined).details).toEqual({
      step_status: "failed",
      error_code: "step_failed",
    });
  });

  test("property: fail decisions are terminal, continue decisions name the step", () => {
    fc.assert(
      fc.property(
        idArb,
        fc.option(fc.constantFrom("fail" as const, "continue" as const), { nil: undefined }),
        fc.constantFrom(...STEP_STATUSES),
        errorArb,
        (id, on_error, status, error) => {
          const decision = decideStepFailure({ id, on_error }, status, error);
          if (decision.kind === "fail") {
            expect(on_error).not.toBe("continue");
            expect(isTerminalExecutionStatus(decision.status)).toBe(true);
          } else {
            expect(on_error).toBe("continue");
            expect(decision.warning.step_key).toBe(id);
          }
        },
      ),
      FC,
    );
  });
});

describe("skippedAfterFailure", () => {
  const steps = [
    { id: "a", kind: "request" },
    { id: "b", kind: "transform" },
    { id: "c", kind: "branch" },
  ];

  test("skips every step after the failure in execution order", () => {
    const order = ["c", "a", "b"];
    const index = new Map(steps.map((s, i) => [s.id, i] as const));
    expect(skippedAfterFailure(order, 0, index, steps)).toEqual([
      {
        step_key: "a",
        step_index: 0,
        kind: "request",
        status: "skipped",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "skipped", message: "skipped due to upstream failure" },
        request_meta: null,
      },
      {
        step_key: "b",
        step_index: 1,
        kind: "transform",
        status: "skipped",
        duration_ms: 0,
        retry_count: 0,
        error: { code: "skipped", message: "skipped due to upstream failure" },
        request_meta: null,
      },
    ]);
  });

  test("falls back to the order position for unknown ids", () => {
    expect(skippedAfterFailure(["x", "y"], 0, new Map(), steps)[0]?.step_key).toBe("b");
  });

  test("property: one summary per remaining step, all skipped", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(["a", "b", "c"]), fc.nat(3), (order, failedAt) => {
        const index = new Map(steps.map((s, i) => [s.id, i] as const));
        const skipped = skippedAfterFailure(order, failedAt, index, steps);
        expect(skipped.map((s) => s.step_key)).toEqual(order.slice(failedAt + 1));
        for (const s of skipped) expect(s.status).toBe("skipped");
      }),
      FC,
    );
  });
});
