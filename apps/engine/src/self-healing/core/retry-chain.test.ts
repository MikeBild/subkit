import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideRepairDisposition, evolveRepairAttempt, finalRepairGate } from "./retry-chain.ts";

test("repair attempts accept only safe, executable, fixture-passing facts", () => {
  expect(
    evolveRepairAttempt({
      classification: "safe",
      fixture_required: true,
      fixture_passed: true,
      executable: true,
    }),
  ).toEqual({ kind: "accept" });
  expect(
    evolveRepairAttempt({
      classification: "safe",
      fixture_required: true,
      fixture_passed: false,
      executable: true,
    }),
  ).toEqual({ kind: "retry", reason: "fixture_failed" });
  expect(
    evolveRepairAttempt({
      classification: "unsafe",
      fixture_required: false,
      fixture_passed: true,
      executable: true,
    }),
  ).toEqual({ kind: "retry", reason: "unsafe" });
  expect(
    evolveRepairAttempt({
      classification: "safe",
      fixture_required: false,
      fixture_passed: true,
      executable: false,
    }),
  ).toEqual({ kind: "retry", reason: "not_executable" });
});

test("final disposition and auto-apply gate are total immutable projections", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (caller, policy, applied, closed) => {
        expect(
          finalRepairGate({ caller_allows_auto_apply: caller, policy_allows_auto_apply: policy }),
        ).toBe(caller && policy);
        expect(decideRepairDisposition({ auto_applied: applied, closed })).toBe(
          applied ? "applied" : closed ? "inapplicable" : "proposed",
        );
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
