import { expect, test } from "bun:test";
import { environmentToCorrectTo, type ReviewLike } from "./resolved-environment";

const review = (
  issues: Array<[string, string]>,
  effects: Array<[string, string | null]>,
  eligible = false,
): ReviewLike => ({
  eligible_for_repeated_runs: eligible,
  manifest: {
    issues: issues.map(([step_id, code]) => ({ step_id, code })),
    effects: effects.map(([step_id, environment]) => ({ step_id, environment })),
  },
});

test("every complaining step agrees on the other half", () => {
  const found = environmentToCorrectTo(
    review(
      [
        ["archive_raw", "environment_mismatch"],
        ["fetch_page", "environment_mismatch"],
        ["write_collection_manifest", "environment_mismatch"],
      ],
      [
        ["archive_raw", "prod"],
        ["fetch_page", "prod"],
        ["write_collection_manifest", "prod"],
      ],
    ),
    "dev",
  );
  expect(found).toBe("prod");
});

test("a workflow whose steps live in both halves is not silently halved", () => {
  expect(
    environmentToCorrectTo(
      review(
        [
          ["a", "environment_mismatch"],
          ["b", "environment_mismatch"],
        ],
        [
          ["a", "prod"],
          ["b", "dev"],
        ],
      ),
      "dev",
    ),
  ).toBeNull();
});

test("a refusal that is not about the environment changes nothing", () => {
  expect(
    environmentToCorrectTo(
      review([["fetch_route", "dynamic_request"]], [["fetch_route", "prod"]]),
      "dev",
    ),
  ).toBeNull();
});

test("a review that was accepted is left alone", () => {
  expect(
    environmentToCorrectTo(review([["a", "environment_mismatch"]], [["a", "prod"]], true), "dev"),
  ).toBeNull();
});

test("already looking at the environment the steps name", () => {
  expect(
    environmentToCorrectTo(review([["a", "environment_mismatch"]], [["a", "prod"]]), "prod"),
  ).toBeNull();
});

test("a complaining step with no effect is a reason switching will not fix", () => {
  expect(
    environmentToCorrectTo(
      review(
        [
          ["a", "environment_mismatch"],
          ["ghost", "environment_mismatch"],
        ],
        [["a", "prod"]],
      ),
      "dev",
    ),
  ).toBeNull();
  expect(
    environmentToCorrectTo(review([["a", "environment_mismatch"]], [["a", null]]), "dev"),
  ).toBeNull();
});

test("nothing to read is not an answer", () => {
  expect(environmentToCorrectTo(null, "dev")).toBeNull();
  expect(environmentToCorrectTo(undefined, "dev")).toBeNull();
  expect(environmentToCorrectTo({ manifest: null }, "dev")).toBeNull();
});
