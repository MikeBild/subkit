import { describe, expect, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi";
import {
  debugErrorText,
  debugStepRow,
  outputSummary,
  ownScopeDraft,
  parseOwnScope,
  STEP_DEBUG_TIMEOUT_MS,
  scopeFromLastRun,
  stepDebugActive,
  stepDebugPhase,
  stepDebugRequest,
  stepDebugStoppable,
} from "@/features/workflows/model/step-debug";

type ExecutionStep = components["schemas"]["ExecutionStep"];

function runStep(over: Partial<ExecutionStep> & { step_key: string }): ExecutionStep {
  return {
    id: over.step_key,
    step_index: 0,
    kind: "request",
    status: "succeeded",
    held: false,
    duration_ms: 12,
    retry_count: 0,
    result_storage_uri: null,
    result_sha256: null,
    result_preview: null,
    credential_snapshots: [],
    started_at: null,
    finished_at: null,
    ...over,
  };
}

describe("step debugger scope from the last run", () => {
  const ids = ["fetch", "shape", "send", "after"];

  test("takes only the steps before the debugged one as envelopes", () => {
    const built = scopeFromLastRun(ids, "send", [
      runStep({ step_key: "fetch", output_preview: { items: [1, 2] } }),
      runStep({ step_key: "shape", output_preview: "ok", duration_ms: null }),
      runStep({ step_key: "send", output_preview: { sent: true } }),
      runStep({ step_key: "after", output_preview: { late: true } }),
    ]);
    expect(built.gaps).toEqual([]);
    expect(built.scope).toEqual({
      fetch: { data: { items: [1, 2] }, duration_ms: 12, error: null },
      shape: { data: "ok", duration_ms: 0, error: null },
    });
  });

  test("names every prior step whose output cannot be reused", () => {
    const built = scopeFromLastRun(["a", "b", "c", "d", "e", "target"], "target", [
      runStep({ step_key: "b", status: "failed", output_preview: { x: 1 } }),
      runStep({ step_key: "c", held: true, output_preview: { x: 1 } }),
      runStep({ step_key: "d", result_storage_uri: "s3://bucket/key", output_preview: "cut" }),
      runStep({ step_key: "e" }),
    ]);
    expect(built.scope).toEqual({});
    expect(built.gaps).toEqual([
      { step: "a", reason: "not_run" },
      { step: "b", reason: "not_finished" },
      { step: "c", reason: "held" },
      { step: "d", reason: "too_large" },
      { step: "e", reason: "no_output" },
    ]);
  });

  test("uses the latest row of a repeated step key", () => {
    const built = scopeFromLastRun(["a", "b"], "b", [
      runStep({ step_key: "a", step_index: 0, output_preview: "old" }),
      runStep({ step_key: "a", step_index: 3, output_preview: "new" }),
    ]);
    expect(built.scope.a).toEqual({ data: "new", duration_ms: 12, error: null });
  });

  test("the first step and an unknown step have an empty scope", () => {
    expect(scopeFromLastRun(ids, "fetch", [])).toEqual({ scope: {}, gaps: [] });
    expect(scopeFromLastRun(ids, "missing", [])).toEqual({ scope: {}, gaps: [] });
  });
});

describe("step debugger own values", () => {
  test("accepts an object and an empty draft", () => {
    expect(parseOwnScope("")).toEqual({ ok: true, scope: {} });
    expect(parseOwnScope('{"fetch":{"data":1}}')).toEqual({
      ok: true,
      scope: { fetch: { data: 1 } },
    });
  });

  test("refuses broken text and anything that is not an object", () => {
    expect(parseOwnScope("{")).toEqual({ ok: false, reason: "not_json" });
    expect(parseOwnScope("[1]")).toEqual({ ok: false, reason: "not_object" });
    expect(parseOwnScope("3")).toEqual({ ok: false, reason: "not_object" });
    expect(parseOwnScope("null")).toEqual({ ok: false, reason: "not_object" });
  });

  test("the draft round-trips", () => {
    const scope = { fetch: { data: { id: 7 }, duration_ms: 0, error: null } };
    expect(parseOwnScope(ownScopeDraft(scope))).toEqual({ ok: true, scope });
  });
});

describe("step debugger request", () => {
  const step = { id: "send", kind: "request", method: "POST" };

  test("always holds writes and carries scope and timeout", () => {
    expect(stepDebugRequest(step, { fetch: { data: 1 } })).toEqual({
      source: "step",
      hold_writes: true,
      step,
      scope: { fetch: { data: 1 } },
      timeout_ms: STEP_DEBUG_TIMEOUT_MS,
    });
  });

  test("leaves an empty scope out", () => {
    expect(stepDebugRequest(step, {})).toEqual({
      source: "step",
      hold_writes: true,
      step,
      timeout_ms: STEP_DEBUG_TIMEOUT_MS,
    });
  });
});

describe("step debugger phase", () => {
  const base = { starting: false, refused: false, execution: null, step: null };

  test("before, while starting and after a refusal", () => {
    expect(stepDebugPhase(base)).toBe("idle");
    expect(stepDebugPhase({ ...base, starting: true })).toBe("starting");
    expect(stepDebugPhase({ ...base, refused: true })).toBe("refused");
  });

  test.each([
    ["queued", "waiting"],
    ["waiting_budget", "waiting"],
    ["running", "running"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["timed_out", "failed"],
    ["aborted", "stopped"],
    ["cancelled", "stopped"],
    ["uncertain", "uncertain"],
    ["something_new", "failed"],
  ] as const)("execution status %s reads as %s", (status, phase) => {
    expect(stepDebugPhase({ ...base, execution: { status } })).toBe(phase);
  });

  test("a succeeded run whose step was held back reads as held", () => {
    expect(
      stepDebugPhase({
        ...base,
        execution: { status: "succeeded" },
        step: { status: "succeeded", held: true },
      }),
    ).toBe("held");
  });

  test("only a waiting or running test can be stopped", () => {
    expect(stepDebugStoppable("waiting")).toBe(true);
    expect(stepDebugStoppable("running")).toBe(true);
    expect(stepDebugStoppable("starting")).toBe(false);
    expect(stepDebugStoppable("succeeded")).toBe(false);
    expect(stepDebugActive("starting")).toBe(true);
    expect(stepDebugActive("uncertain")).toBe(false);
  });
});

describe("step debugger result", () => {
  test("summarises output by its shape", () => {
    expect(outputSummary(null)).toEqual({ kind: "empty" });
    expect(outputSummary({})).toEqual({ kind: "empty" });
    expect(outputSummary([1, 2, 3])).toEqual({ kind: "list", count: 3 });
    expect(outputSummary("done")).toEqual({ kind: "text", text: "done" });
    expect(outputSummary({ id: 7, tags: ["a"], nested: { x: 1 }, none: null })).toEqual({
      kind: "record",
      fields: [
        { name: "id", value: "7" },
        { name: "tags", value: "[1]" },
        { name: "nested", value: "{…}" },
        { name: "none", value: "—" },
      ],
      more: 0,
    });
  });

  test("caps the listed fields and long text", () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, i]));
    const summary = outputSummary(many);
    expect(summary.kind === "record" && summary.fields.length).toBe(6);
    expect(summary.kind === "record" && summary.more).toBe(3);
    const text = outputSummary("x".repeat(500));
    expect(text.kind === "text" && text.text.length).toBe(161);
  });

  test("picks the row of the debugged step", () => {
    const rows = [
      { step_key: "other", step_index: 0 },
      { step_key: "send", step_index: 1 },
    ];
    expect(debugStepRow(rows, "send")).toBe(rows[1] ?? null);
    expect(debugStepRow(rows, "gone")).toBe(rows[0] ?? null);
    expect(debugStepRow([], "send")).toBeNull();
  });

  test("reads an error message from text or an object", () => {
    expect(debugErrorText(null)).toBeNull();
    expect(debugErrorText("boom")).toBe("boom");
    expect(debugErrorText({ code: "x", message: "went wrong" })).toBe("went wrong");
    expect(debugErrorText({ code: "x" })).toBe('{"code":"x"}');
  });
});
