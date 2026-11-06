import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  blockingRepairWarnings,
  type DryRunStepSummary,
  describeUnsupportedPlaceholders,
  dryRunStartLine,
  fieldOf,
  invalidDraftStepId,
  isRunnableStep,
  normalizeRunWarnings,
  repairLoopMessage,
  stepFixtureEnvelope,
  stepLogLevel,
  stepLogLine,
  stoppedStepOf,
  trippedRepairCodes,
  warningsBannerOf,
} from "./dry-run.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

function step(overrides: Partial<DryRunStepSummary> = {}): DryRunStepSummary {
  return {
    step_key: "s1",
    kind: "request",
    status: "succeeded",
    duration_ms: 12,
    error: null,
    ...overrides,
  };
}

function warningRow(tool: string, codes: unknown[]): { tool: string; output: unknown } {
  return { tool, output: { data: { warnings: codes.map((code) => ({ code })) } } };
}

describe("fieldOf", () => {
  test("reads a key of an object and nothing of other values", () => {
    expect(fieldOf({ a: 1 }, "a")).toBe(1);
    expect(fieldOf(null, "a")).toBeUndefined();
    expect(fieldOf(undefined, "a")).toBeUndefined();
    expect(fieldOf("abc", "length")).toBeUndefined();
  });
});

describe("isRunnableStep and invalidDraftStepId", () => {
  test("accepts only objects with a string kind", () => {
    expect(isRunnableStep({ id: "a", kind: "request" })).toBe(true);
    expect(isRunnableStep({ id: "a", kind: 3 })).toBe(false);
    expect(isRunnableStep({ id: "a" })).toBe(false);
    expect(isRunnableStep(null)).toBe(false);
    expect(isRunnableStep("request")).toBe(false);
  });

  test("names the first step id or a placeholder", () => {
    expect(invalidDraftStepId([{ id: "first" }, { id: "second" }])).toBe("first");
    expect(invalidDraftStepId([{ id: 4 }])).toBe("(invalid-draft)");
    expect(invalidDraftStepId([])).toBe("(invalid-draft)");
    expect(invalidDraftStepId([null])).toBe("(invalid-draft)");
  });
});

describe("describeUnsupportedPlaceholders", () => {
  test("joins every finding with its suggestion", () => {
    expect(
      describeUnsupportedPlaceholders([
        { step_id: "a", field: "url", raw: "{{x}}", code: "mustache", did_you_mean: "steps.x" },
        { step_id: "b", field: "body", raw: "$y", code: "bare", did_you_mean: "steps.y" },
      ]),
    ).toBe(
      "step `a`.url: `{{x}}` (mustache) → use `steps.x`; step `b`.body: `$y` (bare) → use `steps.y`",
    );
  });
});

describe("trippedRepairCodes", () => {
  test("counts repeating codes of preview and run tools and trips at three", () => {
    const rows = [
      warningRow("dry_run_workflow", ["unresolved_identifier", "loop_over_unresolved"]),
      warningRow("run_workflow", ["unresolved_identifier", "transform_empty_extraction"]),
      warningRow("dry_run_workflow", ["unresolved_identifier", "loop_over_unresolved"]),
      warningRow("edit_workflow_patch", ["loop_over_unresolved"]),
      warningRow("run_workflow", ["loop_over_unresolved"]),
      warningRow("dry_run_workflow", ["loop_body_empty", "loop_body_empty", "loop_body_empty"]),
    ];
    expect(trippedRepairCodes(rows)).toEqual([
      { code: "unresolved_identifier", count: 3 },
      { code: "loop_over_unresolved", count: 3 },
    ]);
    expect(trippedRepairCodes(rows.slice(0, 4))).toEqual([
      { code: "unresolved_identifier", count: 3 },
    ]);
  });

  test("ignores rows without a warnings array and malformed warnings", () => {
    const rows = [
      { tool: "dry_run_workflow", output: null },
      { tool: "dry_run_workflow", output: { data: { warnings: "unresolved_identifier" } } },
      { tool: "dry_run_workflow", output: { data: null } },
      warningRow("dry_run_workflow", [5, null, "transform_empty_extraction"]),
      {
        tool: "dry_run_workflow",
        output: { data: { warnings: [null, 7, { code: "transform_empty_extraction" }] } },
      },
      warningRow("run_workflow", ["transform_empty_extraction"]),
    ];
    expect(trippedRepairCodes(rows)).toEqual([{ code: "transform_empty_extraction", count: 3 }]);
    expect(trippedRepairCodes(rows.slice(0, 5))).toEqual([]);
  });

  test("never trips a code seen fewer than three times", () => {
    const codeArb = fc.constantFrom(
      "unresolved_identifier",
      "loop_over_unresolved",
      "transform_empty_extraction",
      "loop_body_empty",
    );
    const rowArb = fc.record({
      tool: fc.constantFrom("dry_run_workflow", "run_workflow", "other"),
      codes: fc.array(codeArb, { maxLength: 4 }),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), (raw) => {
        const rows = raw.map((r) => warningRow(r.tool, r.codes));
        const counts = new Map<string, number>();
        for (const r of raw) {
          if (r.tool === "other") continue;
          for (const c of r.codes) counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        for (const t of trippedRepairCodes(rows)) {
          expect(t.code).not.toBe("loop_body_empty");
          expect(t.count).toBe(counts.get(t.code) ?? 0);
          expect(t.count).toBeGreaterThanOrEqual(3);
        }
      }),
      FC,
    );
  });
});

describe("repairLoopMessage", () => {
  test("lists every tripped code with its count", () => {
    expect(
      repairLoopMessage([
        { code: "unresolved_identifier", count: 3 },
        { code: "loop_over_unresolved", count: 4 },
      ]),
    ).toBe(
      "stop — three or more previews in a row produced the same authoring-bug warning(s): `unresolved_identifier` × 3, `loop_over_unresolved` × 4. Re-reading the data-handling skill, asking the user for a clarification, or proposing a structurally different draft is the right move. Another preview with the same draft will produce the same warning.",
    );
  });
});

describe("dryRunStartLine", () => {
  test("pluralises the step count", () => {
    expect(dryRunStartLine(1, "dev")).toBe("dry-running 1 step (env=dev)");
    expect(dryRunStartLine(3, "prod")).toBe("dry-running 3 steps (env=prod)");
  });
});

describe("stepFixtureEnvelope", () => {
  test("keeps output, duration, error and request status and headers", () => {
    expect(
      stepFixtureEnvelope(
        step({
          output_preview: { a: 1 },
          request_meta: { status: 200, headers: { "x-a": "1" } },
        }),
      ),
    ).toEqual({
      data: { a: 1 },
      duration_ms: 12,
      error: null,
      status_code: 200,
      headers: { "x-a": "1" },
    });
  });

  test("defaults duration and error and skips malformed request meta", () => {
    expect(
      stepFixtureEnvelope(
        step({
          output_preview: 0,
          duration_ms: null,
          error: undefined,
          request_meta: { status: "200", headers: null },
        }),
      ),
    ).toEqual({ data: 0, duration_ms: 0, error: null });
    expect(
      stepFixtureEnvelope(step({ output_preview: [], error: "e", request_meta: { headers: "h" } })),
    ).toEqual({ data: [], duration_ms: 12, error: "e" });
    expect(stepFixtureEnvelope(step({ output_preview: "x", request_meta: null }))).toEqual({
      data: "x",
      duration_ms: 12,
      error: null,
    });
  });

  test("returns null for missing, failed, held or empty steps", () => {
    expect(stepFixtureEnvelope(undefined)).toBeNull();
    expect(stepFixtureEnvelope(step({ status: "failed", output_preview: 1 }))).toBeNull();
    expect(stepFixtureEnvelope(step({ held: true, output_preview: 1 }))).toBeNull();
    expect(stepFixtureEnvelope(step({ output_preview: null }))).toBeNull();
    expect(stepFixtureEnvelope(step())).toBeNull();
  });
});

describe("step log", () => {
  test("maps statuses to log levels", () => {
    expect(stepLogLevel("succeeded")).toBe("info");
    expect(stepLogLevel("failed")).toBe("error");
    expect(stepLogLevel("timed_out")).toBe("error");
    expect(stepLogLevel("skipped")).toBe("warn");
  });

  test("formats duration and error message when present", () => {
    expect(stepLogLine(step({ status: "failed", error: { message: "boom" } }))).toBe(
      "step s1 (request) failed · 12ms · boom",
    );
    expect(stepLogLine(step({ duration_ms: null, error: { message: 3 } }))).toBe(
      "step s1 (request) succeeded",
    );
    expect(stepLogLine(step({ duration_ms: 0, error: "boom" }))).toBe(
      "step s1 (request) succeeded · 0ms",
    );
  });
});

describe("stoppedStepOf", () => {
  test("prefers the first failed step and reads its message", () => {
    expect(
      stoppedStepOf([
        step({ step_key: "a", status: "skipped", error: { message: "skip" } }),
        step({ step_key: "b", status: "failed", error: { message: "boom" } }),
      ]),
    ).toEqual({ stoppedId: "b", stoppedMessage: "boom" });
  });

  test("falls back to the first unsuccessful step without a message", () => {
    expect(
      stoppedStepOf([
        step({ step_key: "a" }),
        step({ step_key: "b", status: "skipped", error: { message: "skip" } }),
      ]),
    ).toEqual({ stoppedId: "b", stoppedMessage: null });
    expect(
      stoppedStepOf([step({ step_key: "a", status: "failed", error: { message: 1 } })]),
    ).toEqual({ stoppedId: "a", stoppedMessage: null });
  });

  test("is empty when every step succeeded", () => {
    expect(stoppedStepOf([step(), step({ step_key: "b" })])).toEqual({
      stoppedId: null,
      stoppedMessage: null,
    });
  });
});

describe("warnings", () => {
  test("normalizes missing fields", () => {
    expect(normalizeRunWarnings(undefined)).toEqual([]);
    expect(
      normalizeRunWarnings([{ step_key: "a", code: "c", message: "m" }, {}, { step_key: null }]),
    ).toEqual([
      { step_key: "a", code: "c", message: "m" },
      { step_key: null, code: "unknown", message: "" },
      { step_key: null, code: "unknown", message: "" },
    ]);
  });

  test("keeps only blocking repair warnings", () => {
    const all = [
      "unresolved_identifier",
      "transform_empty_extraction",
      "loop_over_unresolved",
      "loop_body_empty",
      "output_contract_violation",
      "scope_drift",
      "judge_goal_mismatch",
    ].map((code) => ({ code }));
    expect(blockingRepairWarnings(all).map((w) => w.code)).toEqual([
      "unresolved_identifier",
      "transform_empty_extraction",
      "loop_over_unresolved",
      "loop_body_empty",
      "output_contract_violation",
    ]);
  });

  test("builds a banner of sorted unique codes", () => {
    const entries = [{ code: "b" }, { code: "a" }, { code: "b" }];
    expect(warningsBannerOf(entries)).toEqual({
      count: 3,
      codes: ["a", "b"],
      summary: "3 warning(s): a, b",
      entries,
    });
    expect(warningsBannerOf([])).toBeNull();
  });

  test("banner codes are sorted, unique and cover every entry", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ code: fc.string() }), { minLength: 1, maxLength: 8 }),
        (w) => {
          const banner = warningsBannerOf(w);
          expect(banner?.count).toBe(w.length);
          expect(banner?.codes).toEqual([...new Set(w.map((x) => x.code))].sort());
          expect(banner?.entries).toBe(w);
        },
      ),
      FC,
    );
  });
});
