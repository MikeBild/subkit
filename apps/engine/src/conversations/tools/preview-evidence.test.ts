import { expect, test } from "bun:test";
import { previewEvidence } from "./preview-evidence.ts";

test("a green held publication and its skipped dependents are not tested successes", () => {
  expect(
    previewEvidence([
      { step_key: "read", status: "succeeded" },
      { step_key: "publish", status: "succeeded", held: true },
      { step_key: "accept", status: "skipped" },
      { step_key: "broken", status: "failed" },
    ]),
  ).toMatchObject({
    checked_steps: ["read"],
    held_steps: ["publish"],
    skipped_steps: ["accept"],
    failed_steps: ["broken"],
  });
});

test("a not-yet-completed or empty preview cannot manufacture successful checks", () => {
  expect(previewEvidence([]).checked_steps).toEqual([]);
  expect(previewEvidence([{ step_key: "pending", status: "running" }]).checked_steps).toEqual([]);
});
