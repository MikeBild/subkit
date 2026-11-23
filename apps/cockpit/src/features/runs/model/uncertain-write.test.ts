import { expect, test } from "bun:test";
import { isUncertainRun, RESOLVE_WRITE_PERMISSION, uncertainStepKeys } from "./uncertain-write";

test("only the uncertain status asks whether a write arrived", () => {
  expect(isUncertainRun("uncertain")).toBe(true);
  for (const status of ["running", "queued", "failed", "succeeded", "aborted", ""])
    expect(isUncertainRun(status)).toBe(false);
});

test("a run that is not uncertain names no step", () => {
  expect(
    uncertainStepKeys({ status: "running", failure: { step_id: "send" } }, [
      { step_key: "send", status: "uncertain" },
    ]),
  ).toEqual([]);
});

test("the step the engine names in the run's failure comes first", () => {
  expect(
    uncertainStepKeys({ status: "uncertain", failure: { step_id: "send", error_code: "x" } }, [
      { step_key: "send", status: "uncertain" },
      { step_key: "post", status: "uncertain" },
    ]),
  ).toEqual(["send", "post"]);
});

test("the step rows the engine marked uncertain are asked about, running ones are not", () => {
  expect(
    uncertainStepKeys({ status: "uncertain", failure: null }, [
      { step_key: "read", status: "succeeded" },
      { step_key: "send", status: "running" },
      { step_key: "post", status: "uncertain" },
      { step_key: null, status: "uncertain" },
    ]),
  ).toEqual(["post"]);
  expect(uncertainStepKeys({ status: "uncertain", failure: { step_id: 7 } }, [])).toEqual([]);
  expect(uncertainStepKeys({ status: "uncertain", failure: "x" }, [])).toEqual([]);
});

test("resolving a write needs the same permission as on the engine", () => {
  expect(RESOLVE_WRITE_PERMISSION).toBe("execution:abort");
});
