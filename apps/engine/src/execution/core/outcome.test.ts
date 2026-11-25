import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  compareStoppingSteps,
  deriveExecutionOutcome,
  deriveRerunSafety,
  fixedPlannedSteps,
  isFailedRunStatus,
  type OutcomeStepRow,
  pickStoppingStep,
} from "./outcome.ts";

const rerunSafety = {
  mode: "repeat_safe" as const,
  reason: "the complete workflow definition contains only read or local operations",
};

const row = (step_key: string, status: string, second: number): OutcomeStepRow => ({
  step_key,
  kind: "request",
  status,
  error: null,
  held: false,
  started_at: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
});

describe("execution outcome core", () => {
  test("uses normalized rerun facts without validating or inspecting workflow definitions", () => {
    expect(
      deriveRerunSafety({
        source_kind: "saved",
        definition_valid: true,
        requires_preparation: false,
      }),
    ).toEqual(rerunSafety);
    expect(
      deriveRerunSafety({
        source_kind: "saved",
        definition_valid: true,
        requires_preparation: true,
      }),
    ).toEqual({
      mode: "prepare_only",
      reason: "the workflow may repeat external effects and requires preparation",
    });
    expect(
      deriveRerunSafety({
        source_kind: "draft",
        definition_valid: true,
        requires_preparation: false,
      }),
    ).toEqual({ mode: "unavailable", reason: "only saved workflow executions can be rerun" });
  });

  test("does not leak failure facts into a successful projection", () => {
    const result = deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: "none" },
      [row("read", "succeeded", 1)],
      {
        definition_steps: [{ id: "read", kind: "request" }],
        rerun_safety: rerunSafety,
        failure: {
          classification: "driver_error",
          error_code: "unexpected",
          refusal_reason: "unexpected",
          connector: { connector_id: "c-1", reason: "unexpected" },
        },
      },
    );
    expect(result).toMatchObject({
      kind: "succeeded",
      cause_class: null,
      error_code: null,
      refusal_reason: null,
      connector: null,
    });
  });

  test("selects the latest failed row independent of succeeded rows", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("succeeded", "failed", "timed_out", "aborted"), {
          minLength: 1,
          maxLength: 20,
        }),
        (statuses) => {
          const rows = statuses.map((status, index) => row(`step-${index}`, status, index));
          const failedIndexes = statuses
            .map((status, index) => ({ status, index }))
            .filter(({ status }) => status !== "succeeded")
            .map(({ index }) => index);
          const actual = pickStoppingStep(rows, null)?.step_key ?? null;
          const expected = failedIndexes.length > 0 ? `step-${failedIndexes.at(-1)}` : null;
          if (actual !== expected) throw new Error("stopping-step projection drifted");
        },
      ),
      { seed: 20261109, numRuns: 100 },
    );
  });
});

const failureFacts = {
  classification: "driver_error",
  error_code: "connection",
  refusal_reason: "disabled",
  connector: { connector_id: "c-1", reason: "disabled" },
};
const outcomeFacts = {
  definition_steps: [{ id: "read", kind: "request" }],
  rerun_safety: rerunSafety,
  failure: failureFacts,
};

test("status class is projected only for failed and partial outcomes", () => {
  for (const status of ["failed", "timed_out", "aborted", "succeeded", "running"]) {
    for (const status_class of ["5xx", null, undefined] as const) {
      const result = deriveExecutionOutcome(
        { status, failure: { step_id: "read" }, output_contract: "none" },
        [row("read", "failed", 1)],
        {
          ...outcomeFacts,
          failure: { ...failureFacts, ...(status_class === undefined ? {} : { status_class }) },
        },
      );
      if (status !== "running" && status_class) {
        expect(result).toHaveProperty("status_class", status_class);
      } else {
        expect(result).not.toHaveProperty("status_class");
      }
    }
  }
  const result = deriveExecutionOutcome(
    { status: "succeeded", failure: null, output_contract: "none" },
    [row("read", "succeeded", 1)],
    { ...outcomeFacts, failure: { ...failureFacts, status_class: "5xx" } },
  );
  expect(result).not.toHaveProperty("status_class");
});

test("ordinary request metadata without extras is not a held row", () => {
  const result = deriveExecutionOutcome(
    { status: "succeeded", failure: null, output_contract: null },
    [{ ...row("read", "succeeded", 1), request_meta: {} }],
    outcomeFacts,
  );
  expect(result.steps).toEqual({ total: 1, succeeded: 1, failed: 0, held: 0, skipped: 0 });
});

test("model steps count toward a fixed planned step count", () => {
  expect(
    fixedPlannedSteps([
      { id: "read", kind: "request" },
      { id: "draft", kind: "model" },
      { id: "shape", kind: "transform" },
    ]),
  ).toBe(3);
});

test("mixed fixed and dynamic steps do not advertise a fixed planned count", () => {
  expect(
    fixedPlannedSteps([
      { id: "read", kind: "request" },
      { id: "loop", kind: "loop" },
    ]),
  ).toBeNull();
});

test("stopping-step ties preserve later input order across interleaved timestamp groups", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 1, maxLength: 100 }),
      (seconds) => {
        const rows = seconds.map((second, index) => row(String(index), "failed", second));
        let expected = rows[0]!;
        for (const candidate of rows) {
          if (candidate.started_at!.getTime() >= expected.started_at!.getTime())
            expected = candidate;
        }
        expect(pickStoppingStep(rows, null)).toBe(expected);
      },
    ),
    { seed: 20261109, numRuns: 1000 },
  );
});

test("saved invalid definitions require preparation with an explicit reason", () => {
  expect(
    deriveRerunSafety({
      source_kind: "saved",
      definition_valid: false,
      requires_preparation: true,
    }),
  ).toEqual({
    mode: "prepare_only",
    reason: "the persisted workflow definition is unavailable or invalid",
  });
});

test("only terminal failure statuses count as failed runs", () => {
  for (const status of ["failed", "timed_out", "aborted"])
    expect(isFailedRunStatus(status)).toBe(true);
  for (const status of ["queued", "running", "succeeded", "skipped", "held", ""])
    expect(isFailedRunStatus(status)).toBe(false);
});

test("stopping step respects explicit parent IDs, latest timestamp, stable ties and absent timestamps", () => {
  const first = { ...row("read[0]", "failed", 1), started_at: null };
  const last = row("read[1]", "timed_out", 3);
  const other = row("other", "aborted", 4);
  const rows = Object.freeze([other, last, first, row("readExtra", "failed", 5)]);
  expect(pickStoppingStep(rows, "read")).toBe(last);
  expect(pickStoppingStep(rows, "other")).toBe(other);
  expect(pickStoppingStep(rows, "missing")?.step_key).toBe("readExtra");
  expect(pickStoppingStep([last, { ...last, step_key: "tie" }], null)?.step_key).toBe("tie");
  expect(pickStoppingStep([first, { ...first, step_key: "second" }], null)?.step_key).toBe(
    "second",
  );
  expect(pickStoppingStep([], "read")).toBeNull();
});

test("queued and running executions suppress failure facts and do not count unstarted steps as skipped", () => {
  for (const status of ["queued", "waiting_for_device", "running"]) {
    expect(
      deriveExecutionOutcome(
        { status, failure: { step_id: "read" }, output_contract: null },
        [],
        outcomeFacts,
      ),
    ).toEqual({
      kind: "running",
      failed_step: null,
      cause_class: null,
      error_code: null,
      refusal_reason: null,
      connector: null,
      steps: { total: 0, succeeded: 0, failed: 0, held: 0, skipped: 0 },
      output_contract: "none",
      rerun_safety: rerunSafety,
    });
  }
});

test("failure projection preserves cause and connector facts and resolves missing step rows", () => {
  for (const status of ["failed", "timed_out", "aborted"]) {
    expect(
      deriveExecutionOutcome(
        { status, failure: { step_id: "read" }, output_contract: "violated" },
        [],
        outcomeFacts,
      ),
    ).toEqual({
      kind: "failed",
      failed_step: { step_key: "read", kind: "request" },
      cause_class: "driver_error",
      error_code: "connection",
      refusal_reason: "disabled",
      connector: failureFacts.connector,
      steps: { total: 1, succeeded: 0, failed: 0, held: 0, skipped: 1 },
      output_contract: "violated",
      rerun_safety: rerunSafety,
    });
  }
  expect(
    deriveExecutionOutcome(
      { status: "failed", failure: { step_id: "missing" }, output_contract: "invalid" },
      [],
      outcomeFacts,
    ).failed_step,
  ).toEqual({ step_key: "missing", kind: "unknown" });
  expect(
    deriveExecutionOutcome(
      { status: "failed", failure: null, output_contract: "passed" },
      [],
      outcomeFacts,
    ).failed_step,
  ).toBeNull();
});

test("partial projections expose failure details but no refused connector", () => {
  const result = deriveExecutionOutcome(
    { status: "succeeded", failure: null, output_contract: "passed" },
    [row("read[0]", "failed", 1), row("read[1]", "succeeded", 2)],
    outcomeFacts,
  );
  expect(result).toEqual({
    kind: "partial",
    failed_step: { step_key: "read[0]", kind: "request" },
    cause_class: "driver_error",
    error_code: "connection",
    refusal_reason: "disabled",
    connector: null,
    steps: { total: 2, succeeded: 1, failed: 1, held: 0, skipped: 0 },
    output_contract: "passed",
    rerun_safety: rerunSafety,
  });
});

test("held flags take precedence over row status and unknown rows remain in total", () => {
  const rows = [
    { ...row("read", "failed", 1), held: true },
    { ...row("meta", "failed", 2), request_meta: { extras: { held: true } } },
    { ...row("skip", "skipped", 3), request_meta: { extras: { held: "true" } } },
    row("unknown", "new-status", 4),
    row("failure", "failed", 5),
  ];
  expect(
    deriveExecutionOutcome(
      { status: "succeeded", failure: null, output_contract: "none" },
      rows,
      outcomeFacts,
    ),
  ).toMatchObject({
    kind: "held",
    failed_step: null,
    cause_class: null,
    refusal_reason: null,
    steps: { total: 5, succeeded: 0, failed: 1, held: 2, skipped: 1 },
  });
});

test("fixed planned totals require a nonempty flat request/transform definition", () => {
  expect(fixedPlannedSteps([])).toBeNull();
  expect(
    fixedPlannedSteps([
      { id: "a", kind: "request" },
      { id: "b", kind: "transform" },
    ]),
  ).toBe(2);
  for (const kind of ["call", "branch", "loop", "unknown"])
    expect(fixedPlannedSteps([{ id: "a", kind }])).toBeNull();
});

test("projection leaves frozen facts and rows unchanged across repeated calls", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("succeeded", "failed", "skipped", "running"), { maxLength: 20 }),
      (statuses) => {
        const rows = Object.freeze(
          statuses.map((status, index) => Object.freeze(row(`step-${index}`, status, index))),
        );
        const facts = Object.freeze({
          ...outcomeFacts,
          definition_steps: Object.freeze(
            outcomeFacts.definition_steps.map((step) => Object.freeze({ ...step })),
          ),
        });
        const exec = Object.freeze({ status: "succeeded", failure: null, output_contract: "none" });
        const before = JSON.stringify({ exec, rows, facts });
        const first = deriveExecutionOutcome(exec, rows, facts);
        expect(deriveExecutionOutcome(exec, rows, facts)).toEqual(first);
        expect(JSON.stringify({ exec, rows, facts })).toBe(before);
        expect(first.steps.total).toBe(rows.length + 1);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});

test("missing failure IDs cannot select similarly spelled loop steps", () => {
  const latest = row("latest", "failed", 3);
  for (const id of [null, undefined, ""]) {
    expect(pickStoppingStep([row(`${id}[0]`, "failed", 1), latest], id)).toBe(latest);
  }
});

test("stopping-step order prioritizes timestamps and preserves original order at ties", () => {
  const indexed = (index: number, started_at: Date | null) => ({ index, row: { started_at } });
  const early = indexed(8, new Date(10));
  const late = indexed(2, new Date(20));
  expect(compareStoppingSteps(early, late)).toBe(-10);
  expect(compareStoppingSteps(late, early)).toBe(10);
  for (const timestamp of [new Date(10), null, new Date(Number.NaN)]) {
    const first = indexed(2, timestamp);
    const second = indexed(8, timestamp);
    expect(compareStoppingSteps(first, second)).toBe(-6);
    expect(compareStoppingSteps(second, first)).toBe(6);
    expect(compareStoppingSteps(first, first)).toBe(0);
  }
  expect(compareStoppingSteps(indexed(5, null), indexed(2, new Date(10)))).toBe(-10);
  expect(compareStoppingSteps(indexed(5, new Date(Number.NaN)), indexed(2, new Date(10)))).toBe(3);
});
