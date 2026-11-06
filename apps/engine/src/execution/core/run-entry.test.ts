import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { StepResult } from "../types.ts";
import {
  abortedStepSummary,
  branchSkippedStepSummary,
  classifyStepEntry,
  containerChildStepIds,
  failedContainerStepSummary,
  fixtureStepSummary,
  forEachVerdict,
  heldChildStepSummary,
  heldDependencyError,
  heldSkippedStepSummary,
  isFailedStepStatus,
  outcomeStepSummary,
  tallyIterations,
  withContainerFailure,
} from "./run.ts";
import { STEP_STATUSES } from "./status.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;
const idArb = fc.constantFrom("a", "b", "c", "d");

describe("containerChildStepIds", () => {
  test("collects parallel branch and loop body ids only", () => {
    const ids = containerChildStepIds([
      { kind: "parallel", branches: [["p1", "p2"], undefined, ["p3"]] },
      { kind: "parallel" },
      { kind: "loop", body: ["l1"] },
      { kind: "loop", branches: [["lb"]] },
      { kind: "request", body: ["r1"] },
      { kind: "transform", branches: [["t1"]] },
    ] as ReadonlyArray<{ kind: string }>);
    expect([...ids]).toEqual(["p1", "p2", "p3", "l1"]);
  });

  test("property: every collected id is declared by a container", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("parallel", "loop", "request"),
            branches: fc.array(fc.array(idArb)),
            body: fc.array(idArb),
          }),
        ),
        (steps) => {
          const expected = new Set<string>();
          for (const s of steps) {
            if (s.kind === "parallel")
              for (const b of s.branches) for (const id of b) expected.add(id);
            if (s.kind === "loop") for (const id of s.body) expected.add(id);
          }
          expect(containerChildStepIds(steps)).toEqual(expected);
        },
      ),
      FC,
    );
  });
});

describe("classifyStepEntry", () => {
  const base = {
    aborted: false,
    skipped: false,
    containerChild: false,
    fixture: undefined,
    heldDependency: null,
  };

  test("aborted wins over every other fact", () => {
    expect(
      classifyStepEntry({
        aborted: true,
        skipped: true,
        containerChild: true,
        fixture: { data: 1 },
        heldDependency: "h",
      }),
    ).toStrictEqual({ kind: "aborted" });
  });

  test("skipped and container children skip before fixtures", () => {
    expect(classifyStepEntry({ ...base, skipped: true, fixture: { data: 1 } })).toStrictEqual({
      kind: "skipped",
    });
    expect(classifyStepEntry({ ...base, containerChild: true })).toStrictEqual({
      kind: "skipped",
    });
  });

  test("a fixture replays its envelope before the held check", () => {
    const fixture = { data: [1], error: null };
    const entry = classifyStepEntry({ ...base, fixture, heldDependency: "h" });
    expect(entry).toStrictEqual({ kind: "fixture", envelope: fixture, data: [1] });
    expect(entry.kind === "fixture" && entry.envelope).toBe(fixture);
  });

  test("a held dependency skips, otherwise the step runs", () => {
    expect(classifyStepEntry({ ...base, heldDependency: "h" })).toStrictEqual({
      kind: "held",
      dependency: "h",
    });
    expect(classifyStepEntry({ ...base, heldDependency: "" })).toStrictEqual({ kind: "run" });
    expect(classifyStepEntry(base)).toStrictEqual({ kind: "run" });
  });

  test("property: the entry follows the precedence order", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.record({ data: fc.integer() }), { nil: undefined }),
        fc.option(idArb, { nil: null }),
        (aborted, skipped, containerChild, fixture, heldDependency) => {
          const entry = classifyStepEntry({
            aborted,
            skipped,
            containerChild,
            fixture,
            heldDependency,
          });
          const expected = aborted
            ? "aborted"
            : skipped || containerChild
              ? "skipped"
              : fixture !== undefined
                ? "fixture"
                : heldDependency
                  ? "held"
                  : "run";
          expect(entry.kind).toBe(expected);
        },
      ),
      FC,
    );
  });
});

describe("step summaries", () => {
  const step = { id: "s", kind: "request" };

  test("aborted, branch-skipped and fixture summaries", () => {
    expect(abortedStepSummary(step, 2)).toStrictEqual({
      step_key: "s",
      step_index: 2,
      kind: "request",
      status: "aborted",
      duration_ms: 0,
      retry_count: 0,
      error: { code: "aborted", message: "execution aborted" },
    });
    expect(branchSkippedStepSummary(step, 3)).toStrictEqual({
      step_key: "s",
      step_index: 3,
      kind: "request",
      status: "skipped",
      duration_ms: 0,
      retry_count: 0,
      error: { code: "skipped", message: "skipped by branch control flow" },
    });
    expect(fixtureStepSummary(step, 4, { a: 1 })).toStrictEqual({
      step_key: "s",
      step_index: 4,
      kind: "request",
      status: "succeeded",
      duration_ms: 0,
      retry_count: 0,
      error: null,
      output_preview: { a: 1 },
    });
  });

  test("held dependency error and summary name the held step", () => {
    expect(heldDependencyError("w")).toStrictEqual({
      code: "skipped_dependency_held",
      message: 'skipped (depends on held step "w")',
    });
    expect(heldSkippedStepSummary(step, 1, "w")).toStrictEqual({
      step_key: "s",
      step_index: 1,
      kind: "request",
      status: "skipped",
      duration_ms: 0,
      retry_count: 0,
      error: { code: "skipped_dependency_held", message: 'skipped (depends on held step "w")' },
    });
  });

  const heldRequest = { method: "POST", url: "https://x", headers_redacted: {}, body: null };
  const meta = { driver: "http" } as NonNullable<StepResult["request_meta"]>;
  const full: StepResult = {
    status: "succeeded",
    held: true,
    held_request: heldRequest,
    output: 1,
    error: { code: "e", message: "m" },
    retry_count: 2,
    duration_ms: 7,
    request_meta: meta,
  };
  const sparse = { status: "failed" } as StepResult;
  const { held_request: _heldRequest, ...unheld } = full;

  test("held child summaries copy the result and its held request", () => {
    expect(heldChildStepSummary("k", 5, "request", full)).toStrictEqual({
      step_key: "k",
      step_index: 5,
      kind: "request",
      status: "succeeded",
      duration_ms: 7,
      retry_count: 2,
      error: { code: "e", message: "m" },
      request_meta: meta,
      held: true,
      held_request: heldRequest,
    });
    expect(heldChildStepSummary("k", 5, "call", sparse)).toStrictEqual({
      step_key: "k",
      step_index: 5,
      kind: "call",
      status: "failed",
      duration_ms: null,
      retry_count: 0,
      error: null,
      request_meta: null,
      held: true,
    });
  });

  test("failed container summaries never carry request meta", () => {
    expect(failedContainerStepSummary(step, 6, full)).toStrictEqual({
      step_key: "s",
      step_index: 6,
      kind: "request",
      status: "succeeded",
      duration_ms: 7,
      retry_count: 2,
      error: { code: "e", message: "m" },
      request_meta: null,
    });
    expect(failedContainerStepSummary(step, 6, sparse)).toStrictEqual({
      step_key: "s",
      step_index: 6,
      kind: "request",
      status: "failed",
      duration_ms: null,
      retry_count: 0,
      error: null,
      request_meta: null,
    });
  });

  test("outcome summaries add held, preview and raw output when present", () => {
    expect(outcomeStepSummary(step, 0, full, [1], "raw")).toStrictEqual({
      step_key: "s",
      step_index: 0,
      kind: "request",
      status: "succeeded",
      duration_ms: 7,
      retry_count: 2,
      error: { code: "e", message: "m" },
      request_meta: meta,
      held: true,
      held_request: heldRequest,
      output_preview: [1],
      raw_preview: "raw",
    });
    expect(outcomeStepSummary(step, 0, unheld, null, undefined)).toStrictEqual({
      step_key: "s",
      step_index: 0,
      kind: "request",
      status: "succeeded",
      duration_ms: 7,
      retry_count: 2,
      error: { code: "e", message: "m" },
      request_meta: meta,
      held: true,
      output_preview: null,
    });
    expect(
      outcomeStepSummary(step, 0, { ...sparse, held_request: heldRequest }, undefined, undefined),
    ).toStrictEqual({
      step_key: "s",
      step_index: 0,
      kind: "request",
      status: "failed",
      duration_ms: null,
      retry_count: 0,
      error: null,
      request_meta: null,
    });
  });
});

describe("container outcomes", () => {
  test("isFailedStepStatus covers failed, aborted and timed_out", () => {
    for (const status of STEP_STATUSES) {
      expect(isFailedStepStatus(status)).toBe(["failed", "aborted", "timed_out"].includes(status));
    }
  });

  test("forEachVerdict succeeds without a failure and defaults its error", () => {
    expect(forEachVerdict(null)).toStrictEqual({ status: "succeeded", error: null });
    const error = { code: "x", message: "y" };
    const verdict = forEachVerdict({ status: "timed_out", error, retry_count: 0, duration_ms: 1 });
    expect(verdict).toStrictEqual({ status: "timed_out", error });
    expect(verdict.error).toBe(error);
    expect(forEachVerdict({ status: "aborted", retry_count: 0, duration_ms: 1 })).toStrictEqual({
      status: "aborted",
      error: { code: "loop_body_failed", message: "loop body failed" },
    });
  });

  test("withContainerFailure overrides status and error only", () => {
    const outcome = {
      result: { status: "succeeded", retry_count: 1, duration_ms: 3, output: 9 } as StepResult,
      scope_value: 4,
    };
    const fallback = { code: "fb", message: "fallback" };
    const error = { code: "e", message: "m" };
    expect(
      withContainerFailure(
        outcome,
        { status: "failed", error, retry_count: 0, duration_ms: 0 },
        fallback,
      ),
    ).toStrictEqual({
      result: { status: "failed", retry_count: 1, duration_ms: 3, output: 9, error },
      scope_value: 4,
    });
    expect(
      withContainerFailure(
        outcome,
        { status: "aborted", retry_count: 0, duration_ms: 0 },
        fallback,
      ),
    ).toStrictEqual({
      result: { status: "aborted", retry_count: 1, duration_ms: 3, output: 9, error: fallback },
      scope_value: 4,
    });
    expect(outcome.result.status).toBe("succeeded");
  });

  test("tallyIterations counts productive and offloaded iterations", () => {
    const verdicts: Record<string, { productive: boolean; offloaded: boolean }> = {
      a: { productive: true, offloaded: false },
      b: { productive: false, offloaded: true },
      c: { productive: true, offloaded: true },
      d: { productive: false, offloaded: false },
    };
    const classify = (it: unknown) =>
      verdicts[it as string] as { productive: boolean; offloaded: boolean };
    expect(tallyIterations(["a", "b", "c", "d"], classify)).toStrictEqual({
      productive: 2,
      offloaded: 2,
    });
    expect(tallyIterations([], classify)).toStrictEqual({ productive: 0, offloaded: 0 });
  });

  test("property: tallies never exceed the iteration count", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ productive: fc.boolean(), offloaded: fc.boolean() })),
        (its) => {
          const tally = tallyIterations(
            its,
            (it) => it as { productive: boolean; offloaded: boolean },
          );
          expect(tally.productive).toBe(its.filter((i) => i.productive).length);
          expect(tally.offloaded).toBe(its.filter((i) => i.offloaded).length);
        },
      ),
      FC,
    );
  });
});
