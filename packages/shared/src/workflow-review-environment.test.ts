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
