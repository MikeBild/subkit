import { expect, test } from "bun:test";
import type { StepDef } from "../../workflows/types.ts";
import { unverifiedBoundaries } from "./unverified-boundaries.ts";

const steps = [
  { id: "publish", kind: "request", method: "POST", url: "https://api.example.test/p" },
  {
    id: "store",
    kind: "request",
    protocol: "s3",
    method: "PUT",
    connector_id: "00000000-0000-4000-8000-000000000001",
    s3: { key: "k", scope: { key_prefix: "v1/guess/", max_bytes: 10 } },
  },
  {
    id: "notify",
    kind: "request",
    method: "POST",
    url: "https://api.example.test/n",
    boundary: { variables: {}, max_body_bytes: 10, max_calls: 1 },
  },
  { id: "shape", kind: "transform", expression: "return 1;" },
] as unknown as StepDef[];

test("bounded steps the preview skipped, or never ran, are named", () => {
  const notice = unverifiedBoundaries(steps, [
    { step_key: "publish", status: "succeeded" },
    { step_key: "store", status: "skipped" },
    { step_key: "shape", status: "skipped" },
  ]);
  expect(notice?.step_ids).toEqual(["store", "notify"]);
  expect(notice?.message).toContain("`store`");
  expect(notice?.message).toContain("inspect_execution_step");
});

test("a bounded step the preview reached is vouched for, held or not", () => {
  expect(
    unverifiedBoundaries(steps, [
      { step_key: "store", status: "succeeded" },
      { step_key: "notify", status: "failed" },
    ]),
  ).toBeNull();
});
