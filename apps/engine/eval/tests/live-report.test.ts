// Unit coverage for the live-authoring report writer (Fix E):
// envelope extraction, content checks, benchmark-target evaluation
// (boundaries pinned to BENCHMARK_TARGETS), the under-specified
// "judge must block" inversion, and the stable report shape.

import { describe, expect, test } from "bun:test";
import {
  BENCHMARK_TARGETS,
  buildLiveReport,
  evaluateBenchmarkTargets,
  extractJudgeVerdict,
  extractLlmPasses,
  extractPreviews,
  LIVE_SCENARIOS,
  type LiveScenarioSpec,
  runContentChecks,
  type ScenarioObservation,
  scenarioPassed,
  scoreScenario,
} from "../live-report.ts";

const SPEC: LiveScenarioSpec = {
  slug: "droplet-specs-email",
  goal: "Email me the droplet specs.",
  connectors: ["digitalocean", "gmail"],
  expect_judge_block: false,
  content_checks: [
    { name: "recipient", pattern: "mike@mikebild\\.com" },
    { name: "specs", pattern: "vcpu", flags: "i" },
  ],
};

const BLOCK_SPEC: LiveScenarioSpec = {
  slug: "underspecified-judge-block",
  goal: "Email the report.",
  connectors: [],
  expect_judge_block: true,
  content_checks: [],
};

/** A happy-path observation: one author_workflow (1 pass) + one green
 *  judged preview whose artifacts satisfy the content checks. */
function happyObservation(): ScenarioObservation {
  return {
    scenario: SPEC.slug,
    tool_calls: 4,
    results: [
      { tool: "author_workflow", output: { attempts: 1, next: "dry_run_workflow" } },
      {
        tool: "dry_run_workflow",
        output: {
          judge: { verdict: "passes", reason: "ok", missing: [] },
          step_trace: [
            {
              step_id: "send",
              held: true,
              held_request: {
                body: { to: "user@example.com", html: "<p>web — 2 vCPU / 4GB / 80GB</p>" },
              },
            },
          ],
        },
      },
    ],
    status: "committed",
    wall_ms: 42_000,
    tokens: 18_500,
  };
}

describe("extraction helpers", () => {
  test("extractLlmPasses reads attempts off the author_workflow envelope (bare or {ok,data}-wrapped)", () => {
    expect(extractLlmPasses([{ tool: "author_workflow", output: { attempts: 2 } }])).toBe(2);
    expect(
      extractLlmPasses([{ tool: "author_workflow", output: { ok: true, data: { attempts: 1 } } }]),
    ).toBe(1);
    expect(extractLlmPasses([{ tool: "dry_run_workflow", output: { attempts: 9 } }])).toBeNull();
  });

  test("extractPreviews keeps dry_run_workflow envelopes in call order", () => {
    const previews = extractPreviews([
      { tool: "dry_run_workflow", output: { judge: { verdict: "failed" } } },
      { tool: "list_connectors", output: {} },
      { tool: "dry_run_workflow", output: { judge: { verdict: "passes" } } },
    ]);
    expect(previews).toHaveLength(2);
    expect(extractJudgeVerdict(previews[0])).toBe("failed");
    expect(extractJudgeVerdict(previews[1])).toBe("passes");
  });

  test("runContentChecks reports each failed check by name", () => {
    const { pass, failed } = runContentChecks("hello world", [
      { name: "has hello", pattern: "hello" },
      { name: "has specs", pattern: "vcpu", flags: "i" },
    ]);
    expect(pass).toBe(false);
    expect(failed).toEqual(["has specs"]);
  });
});

describe("benchmark targets", () => {
  const base = {
    llm_passes: 1,
    previews: 1,
    tool_calls: 10,
    first_preview_content_pass: true,
    expect_judge_block: false,
    judge: "passes" as string | null,
  };

  test("all targets PASS on the happy shape", () => {
    expect(Object.values(evaluateBenchmarkTargets(base))).toEqual(["PASS", "PASS", "PASS", "PASS"]);
  });

  test("pipeline_llm_calls_le_3 boundary: 3 passes, 4 fails, missing fails", () => {
    expect(
      evaluateBenchmarkTargets({ ...base, llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max })
        .pipeline_llm_calls_le_3,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({
        ...base,
        llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max + 1,
      }).pipeline_llm_calls_le_3,
    ).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, llm_passes: null }).pipeline_llm_calls_le_3).toBe(
      "FAIL",
    );
  });

  test("single_preview demands exactly one preview", () => {
    expect(evaluateBenchmarkTargets({ ...base, previews: 0 }).single_preview).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, previews: 2 }).single_preview).toBe("FAIL");
  });

  test("tool_calls_le_15 boundary: 15 passes, 16 fails, 0 fails (nothing ran)", () => {
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max })
        .tool_calls_le_15,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max + 1 })
        .tool_calls_le_15,
    ).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, tool_calls: 0 }).tool_calls_le_15).toBe("FAIL");
  });

  test("under-specified scenario inverts the content target: a BLOCKING verdict passes, a green pass fails", () => {
    const blockBase = { ...base, expect_judge_block: true, first_preview_content_pass: false };
    expect(
      evaluateBenchmarkTargets({ ...blockBase, judge: "failed" }).content_correct_first_preview,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({ ...blockBase, judge: "partial" }).content_correct_first_preview,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({ ...blockBase, judge: "passes" }).content_correct_first_preview,
    ).toBe("FAIL");
  });
});

describe("scoreScenario", () => {
  test("happy path: stable row shape with every target PASS", () => {
    const score = scoreScenario(SPEC, happyObservation());
    expect(score).toMatchObject({
      scenario: "droplet-specs-email",
      tool_calls: 4,
      llm_passes: 1,
      judge: "passes",
      wall_ms: 42_000,
      content_pass: true,
      tokens: 18_500,
      previews: 1,
      first_preview_content_pass: true,
    });
    expect(Object.values(score.targets)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("content failure on the first preview fails content_pass even when the judge passed", () => {
    const obs = happyObservation();
    const preview = obs.results[1]!.output as Record<string, unknown>;
    preview.step_trace = [{ step_id: "send", held_request: { body: { to: "", html: "" } } }];
    const score = scoreScenario(SPEC, obs);
    expect(score.content_pass).toBe(false);
    expect(score.first_preview_content_pass).toBe(false);
    expect(score.targets.content_correct_first_preview).toBe("FAIL");
    expect(score.notes.join(" ")).toContain("failed content checks");
    expect(scenarioPassed(score)).toBe(false);
  });

  test("judge-block scenario: a blocked first preview is the success condition", () => {
    const score = scoreScenario(BLOCK_SPEC, {
      scenario: BLOCK_SPEC.slug,
      tool_calls: 5,
      results: [
        { tool: "author_workflow", output: { attempts: 1 } },
        {
          tool: "dry_run_workflow",
          output: { judge: { verdict: "failed", reason: "no recipient", missing: ["recipient"] } },
        },
      ],
      status: "active",
      wall_ms: 30_000,
    });
    expect(score.content_pass).toBe(true);
    expect(score.judge).toBe("failed");
    expect(score.targets.content_correct_first_preview).toBe("PASS");
    expect(scenarioPassed(score)).toBe(true);
  });

  test("errored run scores as failed with the error in notes and no crash", () => {
    const score = scoreScenario(SPEC, {
      scenario: SPEC.slug,
      tool_calls: 0,
      results: [],
      status: "error",
      wall_ms: 12,
      error: "connect ECONNREFUSED",
    });
    expect(score.content_pass).toBe(false);
    expect(score.llm_passes).toBeNull();
    expect(score.previews).toBe(0);
    expect(Object.values(score.targets)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL"]);
    expect(score.notes.join(" ")).toContain("ECONNREFUSED");
  });
});

describe("buildLiveReport", () => {
  test("aggregates pass/fail and keeps the stable per-scenario keys", () => {
    const good = scoreScenario(SPEC, happyObservation());
    const bad = scoreScenario(SPEC, {
      scenario: SPEC.slug,
      tool_calls: 0,
      results: [],
      status: "error",
      wall_ms: 1,
      error: "boom",
    });
    const report = buildLiveReport({
      scores: [good, bad],
      engine_host: "engine.example.com",
      started_at: "2026-06-12T00:00:00.000Z",
      finished_at: "2026-06-12T00:05:00.000Z",
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    // Stable contract: these keys are diffed across release runs.
    for (const key of [
      "scenario",
      "tool_calls",
      "llm_passes",
      "judge",
      "wall_ms",
      "content_pass",
      "previews",
      "targets",
    ]) {
      expect(Object.keys(report.scenarios[0]!)).toContain(key);
    }
  });
});

describe("live scenario specs", () => {
  test("3-5 estate-derived scenarios with exactly one judge-block probe and valid regexes", () => {
    expect(LIVE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(LIVE_SCENARIOS.length).toBeLessThanOrEqual(5);
    expect(LIVE_SCENARIOS.filter((s) => s.expect_judge_block)).toHaveLength(1);
    for (const spec of LIVE_SCENARIOS) {
      for (const check of spec.content_checks) {
        // Constructing the RegExp throws on an invalid pattern.
        expect(() => new RegExp(check.pattern, check.flags ?? "")).not.toThrow();
      }
    }
  });

  test("the droplet-specs scenario goal names the recipient (fabricated-recipient regression)", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "droplet-specs-email");
    expect(spec?.goal).toContain("user@example.com");
  });
});
