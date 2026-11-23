import { expect, test } from "bun:test";
import { isUncertainRun, uncertainStepKeys } from "./uncertain-write";

test("only the uncertain status asks whether a write arrived", () => {
  expect(isUncertainRun("uncertain")).toBe(true);
  for (const status of ["running", "queued", "failed", "succeeded", "aborted", ""])
    expect(isUncertainRun(status)).toBe(false);
});

test("a run that is not uncertain names no step", () => {
  expect(
    uncertainStepKeys({ status: "running", error: { step_keys: ["send"] } }, [
      { step_key: "send", status: "running" },
    ]),
  ).toEqual([]);
});

test("the steps the engine names win over the step rows", () => {
  expect(
    uncertainStepKeys({ status: "uncertain", error: { step_keys: ["send[2]", "send[2]", ""] } }, [
      { step_key: "other", status: "running" },
    ]),
  ).toEqual(["send[2]"]);
  expect(uncertainStepKeys({ status: "uncertain", error: { step_id: "send" } }, [])).toEqual([
    "send",
  ]);
});

test("without named steps the interrupted step rows are asked about", () => {
  expect(
    uncertainStepKeys({ status: "uncertain", error: null }, [
      { step_key: "read", status: "succeeded" },
      { step_key: "send", status: "running" },
      { step_key: "post", status: "uncertain" },
      { step_key: null, status: "running" },
    ]),
  ).toEqual(["send", "post"]);
  expect(uncertainStepKeys({ status: "uncertain", error: { step_keys: [7] } }, [])).toEqual([]);
  expect(uncertainStepKeys({ status: "uncertain", error: "x" }, [])).toEqual([]);
});
