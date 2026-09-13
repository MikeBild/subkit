import { describe, expect, test } from "bun:test";

import { compareLiveAuthoringReports } from "../live-benchmark.ts";
import type { LiveAuthoringReport, LiveScenarioScore } from "../live-report.ts";

function score(overrides: Partial<LiveScenarioScore> & { scenario: string }): LiveScenarioScore {
  return {
    scenario: overrides.scenario,
    tool_calls: overrides.tool_calls ?? 4,
    llm_passes: overrides.llm_passes ?? 1,
    judge: overrides.judge ?? "passes",
    wall_ms: overrides.wall_ms ?? 10_000,
    content_pass: overrides.content_pass ?? true,
    tokens: overrides.tokens ?? 1_000,
    previews: overrides.previews ?? 1,
    first_preview_content_pass: overrides.first_preview_content_pass ?? true,
    expect_judge_block: overrides.expect_judge_block ?? false,
    status: overrides.status ?? "committed",
    targets: overrides.targets ?? {
      pipeline_llm_calls_le_3: "PASS",
      single_preview: "PASS",
      tool_calls_le_15: "PASS",
      content_correct_first_preview: "PASS",
    },
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
          targets: {
            pipeline_llm_calls_le_3: "FAIL",
            single_preview: "PASS",
            tool_calls_le_15: "PASS",
            content_correct_first_preview: "PASS",
          },
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
});
