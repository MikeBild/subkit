import { describe, expect, test } from "bun:test";
import {
  errorDetail,
  inputFileUnavailableResult,
  isRunInputObject,
  mergeRunInput,
  missingInputResult,
  missingRequiredFields,
  runOutcomeResult,
  staleVersionResult,
} from "./auto-persist.ts";

describe("run workflow", () => {
  test("a stale expected version refuses the run", () => {
    expect(staleVersionResult("w", "ver-a", "ver-b")).toStrictEqual({
      ok: false,
      error_code: "workflow_version_not_active",
      message:
        "the prepared workflow version is no longer the active version; review the current version before running it",
      data: {
        workflow_id: "w",
        expected_workflow_version_id: "ver-a",
        current_workflow_version_id: "ver-b",
      },
    });
    expect(staleVersionResult("w", "ver-a", undefined)?.data).toStrictEqual({
      workflow_id: "w",
      expected_workflow_version_id: "ver-a",
      current_workflow_version_id: null,
    });
  });

  test("a matching or missing expected version passes", () => {
    expect(staleVersionResult("w", "ver-a", "ver-a")).toBeNull();
    expect(staleVersionResult("w", undefined, "ver-a")).toBeNull();
    expect(staleVersionResult("w", "", "ver-a")).toBeNull();
  });

  test("scalar and list inputs pass through unmerged", () => {
    expect(mergeRunInput("text", { f: 1 }, {}, { a: 1 })).toBe("text");
    expect(mergeRunInput(0, { f: 1 }, {}, {})).toBe(0);
    const list = [1, 2];
    expect(mergeRunInput(list, { f: 1 }, {}, {})).toBe(list);
  });

  test("object inputs merge file, partial and answers in that order", () => {
    expect(
      mergeRunInput({ p: 1 }, { f: 1, k: "file" }, { p: 1, k: "partial" }, { a: 1 }),
    ).toStrictEqual({ f: 1, k: "partial", p: 1, a: 1 });
    expect(mergeRunInput(undefined, { k: "file" }, {}, { k: "answer" })).toStrictEqual({
      k: "answer",
    });
    expect(mergeRunInput(null, { f: 1 }, {}, {})).toStrictEqual({ f: 1 });
  });

  test("only plain objects are checked against the input contract", () => {
    expect(isRunInputObject({})).toBe(true);
    expect(isRunInputObject([])).toBe(false);
    expect(isRunInputObject(null)).toBe(false);
    expect(isRunInputObject("x")).toBe(false);
  });

  test("missing fields are unset, null or blank strings", () => {
    expect(
      missingRequiredFields(["a", "b", "c", "d", "e", "f"], {
        a: undefined,
        b: null,
        c: "  ",
        d: 0,
        e: "x",
      }),
    ).toStrictEqual(["a", "b", "c", "f"]);
  });

  test("one missing form field asks for the full form", () => {
    expect(
      missingInputResult({
        workflowId: "w",
        workflowSlug: "s",
        missing: ["a"],
        structured: [],
        required: ["a", "b"],
      }),
    ).toStrictEqual({
      ok: false,
      error_code: "missing_workflow_input",
      message:
        'Workflow "s" cannot run: required input field `a` is missing from the submitted input. Re-issue run_workflow so it pauses with an ask_user_form that collects EVERY required field (`a`, `b`) — do NOT use a single ask_user_text; the harness runs the workflow with the submitted form values.',
      data: {
        workflow_id: "w",
        workflow_slug: "s",
        missing_fields: ["a"],
        structured_fields: [],
        required_fields: ["a", "b"],
      },
    });
  });

  test("several structured fields are never asked from the user", () => {
    expect(
      missingInputResult({
        workflowId: "w",
        workflowSlug: "s",
        missing: ["a", "b"],
        structured: ["a", "b"],
        required: ["a", "b"],
      }),
    ).toMatchObject({
      message:
        'Workflow "s" cannot run: required input fields `a`, `b` are missing from the submitted input. `a`, `b` are structured data (array or object) that a person cannot type into a form — never ask the user for them and never show raw JSON. Supply them in run_workflow input, or pass input_file from the tool that produced the data (for example export_diagnostic_context), then re-issue run_workflow. Nothing ran.',
    });
  });

  test("one structured field is named in the singular", () => {
    expect(
      missingInputResult({
        workflowId: "w",
        workflowSlug: "s",
        missing: ["a", "b"],
        structured: ["b"],
        required: ["a", "b"],
      }),
    ).toMatchObject({
      message:
        'Workflow "s" cannot run: required input fields `a`, `b` are missing from the submitted input. `b` is structured data (array or object) that a person cannot type into a form — never ask the user for it and never show raw JSON. Supply it in run_workflow input, or pass input_file from the tool that produced the data (for example export_diagnostic_context), then re-issue run_workflow. Nothing ran.',
    });
  });

  test("an unavailable input file names the detail", () => {
    expect(inputFileUnavailableResult("w", "s", "gone")).toStrictEqual({
      ok: false,
      error_code: "input_file_unavailable",
      message:
        'Workflow "s" cannot run: the confirmed input file is no longer available in this conversation (gone). Nothing ran. Re-run the tool that produced the file, then re-issue run_workflow with the fresh input_file reference; do not ask the user to paste its contents.',
      data: { workflow_id: "w", workflow_slug: "s" },
    });
  });

  test("error detail reads messages and stringifies the rest", () => {
    expect(errorDetail(new Error("boom"))).toBe("boom");
    expect(errorDetail("raw")).toBe("raw");
    expect(errorDetail(7)).toBe("7");
  });

  const admitted = { hold_writes: false, workflow_version_id: "v", execution_authority_id: "a" };

  test("a succeeded run without warnings is ok", () => {
    expect(
      runOutcomeResult({
        run: { status: "succeeded", execution_id: "e", output: { x: 1 } },
        admitted,
        workflowId: "w",
        workflowSlug: "s",
        input: { a: 1 },
      }),
    ).toStrictEqual({
      ok: true,
      data: {
        status: "succeeded",
        execution_id: "e",
        workflow_id: "w",
        workflow_slug: "s",
        input: { a: 1 },
        output: { x: 1 },
        execute_writes: true,
        hold_writes: false,
        workflow_version_id: "v",
        execution_authority_id: "a",
      },
    });
  });

  test("a held preview is not ok and says nothing was written", () => {
    const warnings = [{ code: "other" }, { code: "held_preview_no_writes" }];
    expect(
      runOutcomeResult({
        run: { status: "succeeded", execution_id: "e", output: null, warnings },
        admitted: { ...admitted, hold_writes: true },
        workflowId: "w",
        workflowSlug: "s",
        input: null,
      }),
    ).toStrictEqual({
      ok: false,
      data: {
        status: "succeeded",
        execution_id: "e",
        workflow_id: "w",
        workflow_slug: "s",
        input: null,
        output: null,
        execute_writes: false,
        hold_writes: true,
        workflow_version_id: "v",
        execution_authority_id: "a",
        preview: true,
        writes_held: true,
        message: "Nothing was written. The supplied input does not authorize external effects.",
        warnings,
      },
    });
  });

  test("other warnings are kept and a failed run is not ok", () => {
    const result = runOutcomeResult({
      run: { status: "failed", execution_id: "e", output: null, warnings: [{ code: "slow" }] },
      admitted,
      workflowId: "w",
      workflowSlug: "s",
      input: {},
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ warnings: [{ code: "slow" }] });
    expect(result.data).not.toHaveProperty("preview");
    expect(
      runOutcomeResult({
        run: { status: "succeeded", execution_id: "e", output: null, warnings: [] },
        admitted,
        workflowId: "w",
        workflowSlug: "s",
        input: {},
      }),
    ).toMatchObject({ ok: true, data: expect.not.objectContaining({ warnings: [] }) });
  });
});
