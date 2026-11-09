import { expect, test } from "bun:test";
import { environmentToCorrectTo, type ReviewLike } from "./workflow-review-environment.ts";

const mismatch: ReviewLike = {
  manifest: {
    issues: [{ step_id: "a", code: "environment_mismatch" }],
    effects: [{ step_id: "a", environment: "dev" }],
  },
};

test("correction only selects the single fully accounted mismatched environment", () => {
  expect(environmentToCorrectTo(mismatch, "prod", [])).toBe("dev");
  expect(environmentToCorrectTo(mismatch, "dev", [])).toBeNull();
  expect(
    environmentToCorrectTo(
      {
        manifest: {
          issues: [{ step_id: "a", code: "environment_mismatch" }],
          effects: [{ step_id: "a", environment: "prod" }],
        },
      },
      "dev",
      [],
    ),
  ).toBe("prod");
  for (const review of [
    undefined,
    null,
    {},
    { eligible_for_repeated_runs: true, ...mismatch },
    { manifest: null },
    { manifest: {} },
  ])
    expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  expect(environmentToCorrectTo(mismatch, "prod", ["prod"])).toBeNull();
  expect(environmentToCorrectTo(mismatch, "prod", ["dev"])).toBe("dev");
});

test("unrelated issues are ignored and unresolved or conflicting mismatch facts cannot suggest a correction", () => {
  const cases: ReviewLike[] = [
    { manifest: { issues: [{ step_id: "a", code: "other" }] } },
    { manifest: { issues: [{ step_id: null, code: "environment_mismatch" }] } },
    { manifest: { issues: [{ step_id: "a", code: "environment_mismatch" }] } },
    {
      manifest: {
        issues: [{ step_id: "a", code: "environment_mismatch" }],
        effects: [
          { step_id: null, environment: "dev" },
          { step_id: "other", environment: "dev" },
        ],
      },
    },
    {
      manifest: {
        issues: [{ step_id: "a", code: "environment_mismatch" }],
        effects: [{ step_id: "a", environment: "invalid" }],
      },
    },
    {
      manifest: {
        issues: [
          { step_id: "a", code: "environment_mismatch" },
          { step_id: "b", code: "environment_mismatch" },
        ],
        effects: [{ step_id: "a", environment: "dev" }],
      },
    },
    {
      manifest: {
        issues: [{ step_id: "a", code: "environment_mismatch" }],
        effects: [
          { step_id: "a", environment: "dev" },
          { step_id: "a", environment: "prod" },
        ],
      },
    },
  ];
  for (const review of cases) expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  const before = JSON.stringify(mismatch);
  expect(environmentToCorrectTo(mismatch, "prod", [])).toBe("dev");
  expect(JSON.stringify(mismatch)).toBe(before);
});

test("only typed mismatch facts participate in an otherwise complete correction", () => {
  const withUnusableIssue: ReviewLike = {
    manifest: {
      issues: [
        { step_id: "a", code: "environment_mismatch" },
        { step_id: null, code: "environment_mismatch" },
        { step_id: "ignored", code: "other" },
      ],
      effects: [{ step_id: "a", environment: "dev" }],
    },
  };
  expect(environmentToCorrectTo(withUnusableIssue, "prod", [])).toBe("dev");

  const noIssuesWithSentinelNamedEffect: ReviewLike = {
    manifest: { effects: [{ step_id: "Stryker was here", environment: "dev" }] },
  };
  expect(environmentToCorrectTo(noIssuesWithSentinelNamedEffect, "prod", [])).toBeNull();

  const nonMismatchWithEffect: ReviewLike = {
    manifest: {
      issues: [{ step_id: "a", code: "other" }],
      effects: [{ step_id: "a", environment: "dev" }],
    },
  };
  expect(environmentToCorrectTo(nonMismatchWithEffect, "prod", [])).toBeNull();
});

test("missing effects fail closed after a mismatch, without throwing", () => {
  const missingEffects: ReviewLike = {
    manifest: { issues: [{ step_id: "a", code: "environment_mismatch" }] },
  };
  expect(environmentToCorrectTo(missingEffects, "prod", [])).toBeNull();
});

test("unrelated effects neither decide nor account for a mismatched step", () => {
  const completeWithUnrelatedEffect: ReviewLike = {
    manifest: {
      issues: [{ step_id: "a", code: "environment_mismatch" }],
      effects: [
        { step_id: "a", environment: "dev" },
        { step_id: "other", environment: "prod" },
        { step_id: null, environment: "prod" },
      ],
    },
  };
  expect(environmentToCorrectTo(completeWithUnrelatedEffect, "prod", [])).toBe("dev");
});

test("an empty first manifest read returns before any later manifest accessor read", () => {
  let reads = 0;
  const review: ReviewLike = {
    get manifest() {
      reads += 1;
      if (reads === 1) return { issues: [] };
      throw new Error("manifest must not be reread after no mismatches");
    },
  };
  expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  expect(reads).toBe(1);
});

test("a later null manifest remains a fail-closed correction result", () => {
  let reads = 0;
  const review: ReviewLike = {
    get manifest() {
      reads += 1;
      return reads === 1 ? { issues: [{ step_id: "a", code: "environment_mismatch" }] } : null;
    },
  };
  expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  expect(reads).toBe(3);
});

test("a null accounting manifest cannot promote an already resolved environment", () => {
  let reads = 0;
  const review: ReviewLike = {
    get manifest() {
      reads += 1;
      if (reads === 1) return { issues: [{ step_id: "a", code: "environment_mismatch" }] };
      if (reads === 2) return { effects: [{ step_id: "a", environment: "dev" }] };
      return null;
    },
  };
  expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  expect(reads).toBe(3);
});

test("a changing effect step id is reread for membership and accounting", () => {
  let reads = 0;
  const effect = {
    get step_id(): string {
      reads += 1;
      return ["a", "a", "other"][reads - 1] ?? "other";
    },
    environment: "dev",
  };
  const review: ReviewLike = {
    manifest: {
      issues: [{ step_id: "a", code: "environment_mismatch" }],
      effects: [effect],
    },
  };
  expect(environmentToCorrectTo(review, "prod", [])).toBeNull();
  expect(reads).toBe(3);
});
