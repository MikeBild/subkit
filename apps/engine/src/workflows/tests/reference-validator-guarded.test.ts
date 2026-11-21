import { expect, test } from "bun:test";
import { validateStepReferences } from "../reference-validator.ts";

function defWith(expression: string) {
  return {
    slug: "guard-probe",
    name: "guard probe",
    steps: [
      { kind: "transform", id: "rollup_window", language: "javascript", expression: "return {};" },
      { kind: "transform", id: "probe", language: "javascript", expression },
    ],
  } as never;
}

const bad = (expression: string) =>
  validateStepReferences(defWith(expression)).map((e) => e.bad_reference);

test("a ternary that probes for a step does not report it", () => {
  expect(
    bad("const w = input.scope.growth_window ? input.scope.growth_window.data : null;\nreturn w;"),
  ).toEqual([]);
});

test("the other short-circuit guards count too", () => {
  expect(bad("return input.scope.absent_step && input.scope.absent_step.data;")).toEqual([]);
  expect(bad("return input.scope.absent_step || {};")).toEqual([]);
  expect(bad("return input.scope.absent_step?.data ?? {};")).toEqual([]);
  expect(bad("return input?.scope?.absent_step.data;")).toEqual([]);
  expect(
    bad("if (!input.scope.absent_step) return {};\nreturn input.scope.absent_step.data;"),
  ).toEqual([]);
  expect(bad("if (typeof input.scope.absent_step === 'undefined') return {};\nreturn 1;")).toEqual(
    [],
  );
  expect(
    bad("return input.scope.absent_step === null ? {} : input.scope.absent_step.data;"),
  ).toEqual([]);
  expect(
    bad("return 'absent_step' in input.scope ? input.scope['absent_step'].data : {};"),
  ).toEqual([]);
});

test("an unguarded read of a step that does not exist is still refused", () => {
  expect(bad("return input.scope.rollup_windwo.data;")).toEqual(["rollup_windwo"]);
  expect(bad('return input.scope["rollup_windwo"].data;')).toEqual(["rollup_windwo"]);
  expect(
    bad(
      "const a = input.scope.maybe_here ? input.scope.maybe_here.data : 0;\nreturn a + input.scope.typo_here.data;",
    ),
  ).toEqual(["typo_here"]);
});

test("a step that does exist is never reported, guarded or not", () => {
  expect(bad("return input.scope.rollup_window.data;")).toEqual([]);
});

test("a placeholder cannot carry a guard, so it is never suppressed", () => {
  const def = {
    slug: "guard-probe",
    name: "guard probe",
    steps: [
      { kind: "transform", id: "rollup_window", language: "javascript", expression: "return {};" },
      {
        kind: "request",
        id: "call",
        method: "GET",
        path: "/v1/${scope.absent_step.data.id}",
        connector_id: "11111111-1111-4111-8111-111111111111",
      },
    ],
  } as never;
  expect(validateStepReferences(def).map((e) => e.bad_reference)).toEqual(["absent_step"]);
});
