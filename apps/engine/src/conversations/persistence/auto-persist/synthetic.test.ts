import { expect, test } from "bun:test";

import { isCompletedWorkflowPreparation } from "./synthetic.ts";

test("only a completed held workflow preparation counts as successful preparation", () => {
  const prepared = { preview: true, writes_held: true, status: "succeeded" };
  expect(isCompletedWorkflowPreparation("run_workflow", prepared)).toBe(true);
  expect(isCompletedWorkflowPreparation("delete_workflow", prepared)).toBe(false);
  expect(isCompletedWorkflowPreparation(undefined, prepared)).toBe(false);
  for (const status of ["failed", "aborted", "timed_out", "running", "queued"]) {
    expect(isCompletedWorkflowPreparation("run_workflow", { ...prepared, status })).toBe(false);
  }
  for (const data of [undefined, null, false, "succeeded", {}, { status: "succeeded" }]) {
    expect(isCompletedWorkflowPreparation("run_workflow", data)).toBe(false);
  }
  expect(isCompletedWorkflowPreparation("run_workflow", { ...prepared, preview: false })).toBe(
    false,
  );
  expect(isCompletedWorkflowPreparation("run_workflow", { ...prepared, writes_held: false })).toBe(
    false,
  );
});
