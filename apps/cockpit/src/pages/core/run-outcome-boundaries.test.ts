import { expect, test } from "bun:test";
import {
  type ExecutionOutcome,
  payloadEvidence,
  runDisplayState,
  runDurationMs,
  runVerdict,
  stepWasHeld,
  stoppingStep,
  truncatedSteps,
} from "./run-outcome";

function outcome(kind: ExecutionOutcome["kind"]): ExecutionOutcome {
  return {
    kind,
    failed_step: null,
    cause_class: null,
    error_code: null,
    refusal_reason: null,
    connector: null,
    steps: { total: 2, succeeded: 1, failed: 0, held: 1, skipped: 0 },
    output_contract: "none",
    rerun_safety: { mode: "prepare_only", reason: "Review" },
  };
}
const step = (step_key: string, extra: Record<string, unknown> = {}) => ({
  step_key,
  result_preview: null,
  ...extra,
});

test("duration preserves zero and rejects each absent endpoint", () => {
  const at = "2026-01-01T00:00:00Z";
  expect(runDurationMs({ started_at: at, finished_at: at })).toBe(0);
  expect(runDurationMs({ started_at: null, finished_at: at })).toBeNull();
  expect(runDurationMs({ started_at: at, finished_at: null })).toBeNull();
});

test("stopping evidence ignores empty placeholders and respects successful outcomes", () => {
  const failed = step("failed", { error: "actual error" });
  const empty = [null, undefined, "", "  ", "null", "undefined"].map((error, index) =>
    step(`empty${index}`, { error }),
  );
  for (const kind of ["failed", "partial"] as const)
    expect(stoppingStep([...empty, failed], outcome(kind))).toBe(failed);
  for (const kind of ["succeeded", "held"] as const)
    expect(stoppingStep([failed], outcome(kind))).toBeNull();
  expect(stoppingStep(empty, null)).toBeNull();
  expect(stoppingStep([failed], null)).toBe(failed);
  const missing = {
    ...outcome("failed"),
    failed_step: { step_key: "missing", kind: "transform" },
  } satisfies ExecutionOutcome;
  expect(stoppingStep([failed], missing)).toBe(failed);
});

test("payload uses the last real value and outcome success over transport status", () => {
  const steps = [
    step("first", { output_preview: "first" }),
    step("last", { output_preview: "last" }),
  ];
  expect(payloadEvidence(steps, "failed", outcome("succeeded"))).toEqual({
    text: "last",
    stepKey: null,
    preview: false,
  });
  expect(payloadEvidence(steps, "succeeded", outcome("partial"))).toEqual({
    text: "last",
    stepKey: "last",
    preview: false,
  });
  expect(payloadEvidence([step("blank", { output_preview: "   " })], "failed")).toBeNull();
  expect(
    payloadEvidence([step("undefined", { output_preview: "undefined" })], "failed"),
  ).toBeNull();
  expect(payloadEvidence([step("object", { output_preview: { answer: 1 } })], "failed")?.text).toBe(
    '{\n  "answer": 1\n}',
  );
  expect(steps.map((value) => value.step_key)).toEqual(["first", "last"]);
});

test("truncation accepts records only, finds matching warnings, and deduplicates steps", () => {
  const valid = step("limited", {
    request_meta: { pagination: { truncated: true, limit: "max_items" } },
  });
  expect(truncatedSteps([valid, valid])).toEqual([{ step: "limited", limit: "max_items" }]);
  for (const value of [
    null,
    undefined,
    false,
    3,
    "pagination",
    [],
    Object.assign([], { pagination: { truncated: true, limit: "max_items" } }),
  ]) {
    expect(
      truncatedSteps([step("invalid", { request_meta: value, output_preview: value })]),
    ).toEqual([]);
  }
  expect(
    truncatedSteps([
      step("warning", {
        output_preview: {
          warnings: [
            null,
            "bad",
            { code: "unrelated" },
            { code: "pagination_truncated", details: { limit: "max_bytes" } },
          ],
        },
      }),
    ]),
  ).toEqual([{ step: "warning", limit: "max_bytes" }]);
  expect(
    truncatedSteps([step("warning", { output_preview: { warnings: [{ code: "unrelated" }] } })]),
  ).toEqual([]);
});

test("held evidence rejects malformed envelopes and needs the held flag", () => {
  for (const request_meta of [
    undefined,
    null,
    false,
    3,
    "meta",
    {},
    { extras: undefined },
    { extras: null },
    { extras: "held" },
    { extras: {} },
    { extras: { held: false } },
    { extras: { held: "true" } },
  ])
    expect(stepWasHeld({ request_meta })).toBe(false);
  expect(stepWasHeld({ request_meta: { extras: { held: true } } })).toBe(true);
  expect(runDisplayState("failed", null)).toBe("failed");
  expect(runDisplayState("succeeded", { kind: "partial" })).toBe("succeeded");
});

test("verdict keeps successful labels and normalizes failed outcomes with nonfailed transport status", () => {
  const translate = (key: string) => key;
  const label = (status: string) => `status:${status}`;
  expect(runVerdict("succeeded", outcome("succeeded"), translate, label)).toEqual({
    label: "status:succeeded",
    tone: null,
  });
  expect(runVerdict("succeeded", outcome("failed"), translate, label)).toEqual({
    label: "status:failed",
    tone: "critical",
  });
  expect(runVerdict("running", null, translate, label, [{ step: "x", limit: null }])).toEqual({
    label: "status:running",
    tone: null,
  });
});

test("unserializable payloads and changing serializers cannot fabricate evidence", () => {
  expect(
    payloadEvidence([step("function", { output_preview: () => undefined })], "failed"),
  ).toBeNull();
  let calls = 0;
  const changing = { toJSON: () => (++calls === 1 ? "first" : undefined) };
  expect(payloadEvidence([step("changing", { output_preview: changing })], "failed")).toBeNull();
  const invalidRecord = Object.assign(() => undefined, {
    pagination: { truncated: true, limit: "max_items" },
    warnings: [{ code: "pagination_truncated", details: { limit: "max_items" } }],
  });
  expect(
    truncatedSteps([
      step("function", { request_meta: invalidRecord, output_preview: invalidRecord }),
    ]),
  ).toEqual([]);
});

test("an empty failed-step key does not select an unrelated empty-key step", () => {
  const failed = step("failed", { error: "actual error" });
  const model = { ...outcome("failed"), failed_step: { step_key: "", kind: "transform" } };
  expect(stoppingStep([step(""), failed], model)).toBe(failed);
});

test("a succeeded outcome controls tone even if the transport status is failed", () => {
  expect(
    runVerdict(
      "failed",
      outcome("succeeded"),
      (key) => key,
      (status) => status,
    ),
  ).toEqual({ label: "failed", tone: null });
});
