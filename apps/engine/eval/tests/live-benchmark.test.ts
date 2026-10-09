import { describe, expect, test } from "bun:test";
import { compareLiveAuthoringReports, compareTargets } from "../live-benchmark.ts";
import type {
  ClarificationTargets,
  LiveAuthoringReport,
  LiveScenarioScore,
} from "../live-report.ts";

const AUTHORING_PASS = {
  pipeline_llm_calls_le_3: "PASS",
  single_preview: "PASS",
  tool_calls_le_15: "PASS",
  content_correct_first_preview: "PASS",
} as const;

const CLARIFICATION_PASS: ClarificationTargets = {
  single_clarifying_question: "PASS",
  no_authoring_before_answer: "PASS",
  question_names_missing_inputs: "PASS",
  no_placeholder_in_reply: "PASS",
};

function score(overrides: Partial<LiveScenarioScore> & { scenario: string }): LiveScenarioScore {
  return {
    scenario: overrides.scenario,
    kind: overrides.kind ?? "authoring",
    tool_calls: overrides.tool_calls ?? 4,
    llm_passes: overrides.llm_passes ?? 1,
    judge: overrides.judge ?? "passes",
    wall_ms: overrides.wall_ms ?? 10_000,
    content_pass: overrides.content_pass ?? true,
    tokens: overrides.tokens ?? 1_000,
    previews: overrides.previews ?? 1,
    first_preview_content_pass: overrides.first_preview_content_pass ?? true,
    converged: overrides.converged ?? true,
    previews_to_pass: overrides.previews_to_pass ?? 1,
    probe_before_author: overrides.probe_before_author ?? true,
    dry_run_before_save: overrides.dry_run_before_save ?? true,
    guard_fired: overrides.guard_fired ?? null,
    auto_repaired_first_preview: overrides.auto_repaired_first_preview ?? false,
    status: overrides.status ?? "committed",
    targets: overrides.targets ?? { ...AUTHORING_PASS },
    notes: overrides.notes ?? [],
  };
}

function report(scenarios: LiveScenarioScore[]): LiveAuthoringReport {
  return {
    started_at: "2026-06-13T00:00:00.000Z",
    finished_at: "2026-06-13T00:01:00.000Z",
    engine_host: "example.test",
    total: scenarios.length,
    passed: scenarios.length,
    failed: 0,
    scenarios,
  };
}

describe("live authoring benchmark comparison", () => {
  test("passes when changes are inside thresholds", () => {
    const comparison = compareLiveAuthoringReports(
      report([score({ scenario: "a", wall_ms: 10_000, tokens: 1_000 })]),
      report([score({ scenario: "a", wall_ms: 11_000, tokens: 1_100 })]),
    );
    expect(comparison.passed).toBe(true);
    expect(comparison.regressions).toHaveLength(0);
  });

  test("fails on target regressions and missing scenarios", () => {
    const comparison = compareLiveAuthoringReports(
      report([score({ scenario: "a" }), score({ scenario: "missing" })]),
      report([
        score({
          scenario: "a",
          targets: { ...AUTHORING_PASS, pipeline_llm_calls_le_3: "FAIL" },
        }),
      ]),
    );
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.map((r) => r.metric)).toContain("target.pipeline_llm_calls_le_3");
    expect(comparison.regressions.map((r) => r.metric)).toContain("scenario");
  });

  test("flags wall-clock and tool-call regressions above thresholds", () => {
    const comparison = compareLiveAuthoringReports(
      report([score({ scenario: "slow", wall_ms: 10_000, tool_calls: 4 })]),
      report([score({ scenario: "slow", wall_ms: 20_000, tool_calls: 8 })]),
    );
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.map((r) => r.metric)).toEqual(
      expect.arrayContaining(["wall_ms", "tool_calls"]),
    );
  });

  test("clarification targets are compared key-wise like authoring targets", () => {
    const comparison = compareLiveAuthoringReports(
      report([
        score({
          scenario: "ask",
          kind: "clarification",
          targets: { ...CLARIFICATION_PASS, placeholder_rejected_after_answer: "PASS" },
          guard_fired: true,
        }),
      ]),
      report([
        score({
          scenario: "ask",
          kind: "clarification",
          targets: { ...CLARIFICATION_PASS, placeholder_rejected_after_answer: "FAIL" },
          guard_fired: false,
        }),
      ]),
    );
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.map((r) => r.metric).sort()).toEqual([
      "guard_fired",
      "target.placeholder_rejected_after_answer",
    ]);
  });

  test("a scenario whose kind changed reports the shape difference as info, not as a regression", () => {
    const comparison = compareLiveAuthoringReports(
      report([score({ scenario: "u" })]),
      report([score({ scenario: "u", kind: "clarification", targets: CLARIFICATION_PASS })]),
    );
    expect(comparison.passed).toBe(true);
    expect(comparison.changes.map((c) => c.metric)).toContain("kind");
    expect(comparison.changes.every((c) => c.severity === "info")).toBe(true);
  });
});

describe("compareTargets", () => {
  test("PASS -> FAIL regresses, FAIL -> PASS improves, same verdict is silent", () => {
    const changes = compareTargets(
      "s",
      { ...AUTHORING_PASS, single_preview: "FAIL" },
      { ...AUTHORING_PASS, tool_calls_le_15: "FAIL" },
    );
    expect(changes.map((c) => [c.metric, c.severity])).toEqual([
      ["target.single_preview", "improvement"],
      ["target.tool_calls_le_15", "regression"],
    ]);
  });

  test("a target present on one side only is info and names the side", () => {
    const changes = compareTargets("s", CLARIFICATION_PASS, {
      ...CLARIFICATION_PASS,
      placeholder_rejected_after_answer: "PASS",
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      metric: "target.placeholder_rejected_after_answer",
      severity: "info",
      baseline: null,
      current: "PASS",
    });
    expect(changes[0]?.message).toContain("only in current");
  });
});
