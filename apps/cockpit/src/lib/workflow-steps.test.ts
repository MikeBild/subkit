import { describe, expect, test } from "bun:test";
import {
  type ExecutionStep,
  joinStepsWithLastRun,
  readStepDefinition,
  stepResultPreview,
} from "./workflow-steps";

function runStep(overrides: Partial<ExecutionStep> & { step_key: string }): ExecutionStep {
  return {
    id: `run-${overrides.step_key}`,
    step_index: 0,
    kind: "request",
    status: "succeeded",
    duration_ms: 12,
    retry_count: 0,
    result_storage_uri: null,
    result_preview: null,
    output_preview: null,
    error: null,
    request_meta: null,
    started_at: "2026-08-17T10:00:00.000Z",
    finished_at: "2026-08-17T10:00:01.000Z",
    ...overrides,
  } as ExecutionStep;
}

describe("step definition", () => {
  test("names a step without an id by its position instead of leaving it blank", () => {
    expect(readStepDefinition({ kind: "request" }, 2).id).toBe("step-3");
  });

  test("picks the first recognisable detail of the step", () => {
    expect(
      readStepDefinition({ id: "a", kind: "transform", expression: "x => x.id" }, 0).detail,
    ).toBe("x => x.id");
    expect(readStepDefinition({ id: "b", kind: "request", path: "/orders" }, 0).detail).toBe(
      "/orders",
    );
  });
});

describe("joining a definition with its last run", () => {
  const steps = [
    { id: "fetch", kind: "request" },
    { id: "shape", kind: "transform" },
  ];

  test("matches by step id and leaves an unrun step empty", () => {
    const views = joinStepsWithLastRun(steps, [
      runStep({ step_key: "fetch", result_preview: "ok" }),
    ]);
    expect(views[0]?.lastRun?.result_preview).toBe("ok");
    expect(views[1]?.lastRun).toBeNull();
  });

  test("keeps the latest attempt when a step ran more than once", () => {
    const views = joinStepsWithLastRun(steps, [
      runStep({ step_key: "fetch", step_index: 0, result_preview: "first" }),
      runStep({ step_key: "fetch", step_index: 3, result_preview: "retry" }),
    ]);
    expect(views[0]?.lastRun?.result_preview).toBe("retry");
  });
});

describe("step result preview", () => {
  test("an error outranks a result so a failure is never shown as output", () => {
    expect(stepResultPreview(runStep({ step_key: "a", error: "boom", result_preview: "ok" }))).toBe(
      "boom",
    );
  });

  test("prefers the structured value over the string blurb", () => {
    expect(
      stepResultPreview(
        runStep({ step_key: "a", output_preview: { count: 2 }, result_preview: "two" }),
      ),
    ).toBe('{\n  "count": 2\n}');
  });

  test("a step that never ran has nothing to show", () => {
    expect(stepResultPreview(null)).toBeNull();
  });
});
