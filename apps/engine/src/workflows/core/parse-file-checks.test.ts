import { describe, expect, test } from "bun:test";
import type { StepDef } from "../types.ts";
import { parseFileValidationErrors } from "./parse-file-checks.ts";
import { validateWorkflowDef } from "./validator.ts";

type TransformStep = Extract<StepDef, { kind: "transform" }>;

function reader(source: string, extra: Partial<TransformStep> = {}): TransformStep {
  return {
    id: "read",
    kind: "transform",
    language: "parse-file",
    file: { source },
    ...extra,
  } as TransformStep;
}

const ids = new Set(["download", "read"]);

describe("parseFileValidationErrors", () => {
  test("run inputs, run state and known steps are accepted", () => {
    expect(parseFileValidationErrors(reader("$input.invoice"), ids, false)).toEqual([]);
    expect(parseFileValidationErrors(reader("$input"), ids, false)).toEqual([]);
    expect(parseFileValidationErrors(reader("$state.upload"), ids, false)).toEqual([]);
    expect(parseFileValidationErrors(reader("download.data"), ids, false)).toEqual([]);
  });

  test("a step without a file block has nothing to check", () => {
    const step = { id: "read", kind: "transform", language: "parse-file" } as TransformStep;
    expect(parseFileValidationErrors(step, ids, false)).toEqual([]);
  });

  test("the loop item is accepted only inside for_each", () => {
    expect(
      parseFileValidationErrors(
        reader("$item.file", { for_each: "(s) => s.download.data.items" }),
        ids,
        false,
      ),
    ).toEqual([]);
    const errors = parseFileValidationErrors(reader("$item.file"), ids, false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("steps.read.file.source");
    expect(errors[0]?.message).toContain("no `for_each`");
  });

  test("a step cannot read its own output", () => {
    const errors = parseFileValidationErrors(reader("read.data"), ids, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("points at this step itself");
  });

  test("unknown roots are refused", () => {
    const errors = parseFileValidationErrors(reader("$inputs.doc"), ids, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("unknown root `$inputs`");
  });

  test("unknown steps are refused with a suggestion unless forward refs are allowed", () => {
    const errors = parseFileValidationErrors(reader("downlaod.data"), ids, false);
    expect(errors).toEqual([
      {
        path: "steps.read.file.source",
        message:
          '`downlaod.data` references unknown step "downlaod" — did you mean: download. Point `file.source` at an earlier step\'s output or at `$input`.',
      },
    ]);
    expect(parseFileValidationErrors(reader("later.data"), ids, true)).toEqual([]);
  });

  test("an unknown step without a near match has no suggestion", () => {
    const errors = parseFileValidationErrors(reader("zzzzzzzzzz.data"), ids, false);
    expect(errors[0]?.message).not.toContain("did you mean");
  });
});

describe("validateWorkflowDef with a parse-file step", () => {
  const download = { id: "download", kind: "request", method: "GET", url: "https://example.test" };

  test("a source pointing at an earlier step saves", () => {
    const result = validateWorkflowDef({
      name: "Read",
      steps: [download, reader("download.data")],
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a source pointing at a missing step is refused, or kept in a draft", () => {
    const definition = { name: "Read", steps: [reader("missing.data")] };
    const rejected = validateWorkflowDef(definition);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.map((error) => error.path)).toEqual(["steps.read.file.source"]);
    expect(validateWorkflowDef(definition, { allowForwardRefs: true }).ok).toBe(true);
  });
});
