import { expect, test } from "bun:test";
import fc from "fast-check";
import { type AutohealPolicy, decideAutoApply } from "./auto-apply-policy.ts";

test("gate repairs and never-auto policy always require review", () => {
  expect(
    decideAutoApply({
      policy: "safe-patches",
      classification: "safe",
      has_fixture: false,
      fixture_passed: true,
      drift_kind: "gate_block",
    }),
  ).toEqual({ auto_apply: false, reason: "gate_repair_requires_review" });
  expect(
    decideAutoApply({
      policy: "never-auto",
      classification: "safe",
      has_fixture: true,
      fixture_passed: true,
    }),
  ).toEqual({ auto_apply: false, reason: "policy=never-auto" });
});

test("safe-patches checks classification and only demands a fixture result when present", () => {
  for (const has_fixture of [false, true])
    for (const fixture_passed of [false, true]) {
      expect(
        decideAutoApply({
          policy: "safe-patches",
          classification: "unsafe",
          has_fixture,
          fixture_passed,
        }),
      ).toEqual({ auto_apply: false, reason: "unsafe_classification" });
      expect(
        decideAutoApply({
          policy: "safe-patches",
          classification: "safe",
          has_fixture,
          fixture_passed,
        }),
      ).toEqual({
        auto_apply: !has_fixture || fixture_passed,
        reason: !has_fixture
          ? "safe_no_fixture"
          : fixture_passed
            ? "safe_and_fixture_passed"
            : "fixture_failed",
      });
    }
});

test("dry-run-gate requires a present passing fixture even for safe patches", () => {
  for (const classification of ["safe", "unsafe"] as const)
    for (const has_fixture of [false, true])
      for (const fixture_passed of [false, true])
        expect(
          decideAutoApply({ policy: "dry-run-gate", classification, has_fixture, fixture_passed }),
        ).toEqual({
          auto_apply: has_fixture && fixture_passed,
          reason: !has_fixture
            ? "no_fixture"
            : fixture_passed
              ? "fixture_passed"
              : "fixture_failed",
        });
  expect(
    decideAutoApply({
      policy: "future-policy" as AutohealPolicy,
      classification: "safe",
      has_fixture: true,
      fixture_passed: true,
    }),
  ).toEqual({ auto_apply: false, reason: "unknown" });
});

test("gate review overrides every policy and preserves frozen facts", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<AutohealPolicy>("safe-patches", "dry-run-gate", "never-auto"),
      fc.boolean(),
      fc.boolean(),
      (policy, has_fixture, fixture_passed) => {
        const facts = Object.freeze({
          policy,
          classification: "safe" as const,
          has_fixture,
          fixture_passed,
          drift_kind: "gate_block",
        });
        const before = JSON.stringify(facts);
        expect(decideAutoApply(facts)).toEqual({
          auto_apply: false,
          reason: "gate_repair_requires_review",
        });
        expect(JSON.stringify(facts)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
