import { describe, expect, test } from "bun:test";
import type { StepDef } from "../types.ts";
import { transformInputValidationErrors } from "./transform-input-checks.ts";
import { validateWorkflowDef } from "./validator.ts";

type TransformStep = Extract<StepDef, { kind: "transform" }>;

const fetchStep = { id: "fetch", kind: "request", method: "GET", url: "https://example.test" };

function converter(inputFrom: string, extra: Partial<TransformStep> = {}): TransformStep {
  return {
    id: "convert",
    kind: "transform",
    language: "html-to-markdown",
    input_from: inputFrom,
    ...extra,
  } as TransformStep;
}

const stepOrder = new Map([
  ["fetch", 0],
  ["convert", 1],
  ["later", 2],
]);

describe("transformInputValidationErrors", () => {
  test("an earlier step and the loop item are accepted", () => {
    expect(transformInputValidationErrors(converter("fetch.data"), stepOrder, false)).toEqual([]);
    expect(transformInputValidationErrors(converter("fetch"), stepOrder, false)).toEqual([]);
    expect(transformInputValidationErrors(converter("fetch.data[0]"), stepOrder, false)).toEqual(
      [],
    );
    expect(transformInputValidationErrors(converter("$item.html"), stepOrder, false)).toEqual([]);
  });

  test("a step without input_from has nothing to check", () => {
    const step = { id: "convert", kind: "transform", language: "readability" } as TransformStep;
    expect(transformInputValidationErrors(step, stepOrder, false)).toEqual([]);
  });

  test("the step itself is refused", () => {
    const errors = transformInputValidationErrors(converter("convert.data"), stepOrder, true);
    expect(errors.map((error) => error.path)).toEqual(["steps.convert.input_from"]);
    expect(errors[0]?.message).toContain("points at this step itself");
  });

  test("a step declared after this one is refused, also in a draft", () => {
    const errors = transformInputValidationErrors(converter("later.data"), stepOrder, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("declared after");
  });

  test("other run roots are refused", () => {
    const errors = transformInputValidationErrors(converter("$input.url"), stepOrder, false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("`$input`");
  });

  test("an unknown step is refused with a suggestion unless forward refs are allowed", () => {
    expect(transformInputValidationErrors(converter("fecth.data"), stepOrder, false)).toEqual([
      {
        path: "steps.convert.input_from",
        message:
          '`fecth.data` references unknown step "fecth" — did you mean: fetch. Point `input_from` at an earlier step\'s output such as `fetch.data`.',
      },
    ]);
    expect(transformInputValidationErrors(converter("missing.data"), stepOrder, true)).toEqual([]);
  });
});

describe("validateWorkflowDef with input_from", () => {
  test("a transform reading an earlier step saves", () => {
    const result = validateWorkflowDef({
      name: "Convert",
      steps: [fetchStep, converter("fetch.data")],
    });
    expect(result.errors).toEqual([]);
  });

  test("a transform reading a later step is refused", () => {
    const result = validateWorkflowDef({
      name: "Convert",
      steps: [converter("fetch.data"), fetchStep],
    });
    expect(result.errors.map((error) => error.path)).toEqual(["steps.convert.input_from"]);
  });

  test("parse-file reads its file block, not input_from", () => {
    const result = validateWorkflowDef({
      name: "Read",
      steps: [
        fetchStep,
        converter("fetch.data", { language: "parse-file", file: { source: "fetch.data" } }),
      ],
    });
    expect(result.errors.map((error) => error.path)).toEqual(["steps.1.input_from"]);
  });
});
