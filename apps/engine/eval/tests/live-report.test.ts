// Unit coverage for the live-authoring report writer (Fix E):
// envelope extraction, content checks, benchmark-target evaluation
// (boundaries pinned to BENCHMARK_TARGETS), the under-specified
// "judge must block" inversion, and the stable report shape.

import { describe, expect, test } from "bun:test";

import {
  aggregateTrials,
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
    { name: "recipient", pattern: "user@example\\.com" },
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
  test("curated estate scenarios + bounded probe scenarios, exactly one judge-block probe, valid regexes", () => {
    // Core estate-derived scenarios plus a few `ta-*` probe scenarios (added
    // for the skills-in-authoring evidence experiments) — kept bounded so the
    // live eval stays cheap. Exactly one deliberately under-specified
    // judge-block probe.
    expect(LIVE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(LIVE_SCENARIOS.length).toBeLessThanOrEqual(8);
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

describe("scoreScenario · convergence metric (previews_to_pass / converged)", () => {
  const FINAL_SPEC: LiveScenarioSpec = {
    slug: "conv-probe",
    goal: "return an object with spread_c",
    connectors: ["open-meteo"],
    expect_judge_block: false,
    content_source: "final_output",
    content_checks: [{ name: "spread numeric", pattern: '"spread_c"\\s*:\\s*-?\\d+(\\.\\d+)?' }],
  };
  const preview = (final_output: unknown) => ({
    tool: "dry_run_workflow",
    output: { final_output },
  });

  test("first preview wrong, second correct → converged, previews_to_pass=2, first-shot still false", () => {
    const score = scoreScenario(FINAL_SPEC, {
      scenario: FINAL_SPEC.slug,
      tool_calls: 6,
      status: "committed",
      wall_ms: 1,
      results: [
        { tool: "author_workflow", output: { attempts: 1 } },
        preview({ spread_c: null }),
        preview({ spread_c: 3.4 }),
      ],
    });
    expect(score.first_preview_content_pass).toBe(false);
    expect(score.converged).toBe(true);
    expect(score.previews_to_pass).toBe(2);
  });

  test("all previews wrong → not converged, previews_to_pass null", () => {
    const score = scoreScenario(FINAL_SPEC, {
      scenario: FINAL_SPEC.slug,
      tool_calls: 4,
      status: "awaiting_input",
      wall_ms: 1,
      results: [preview({ spread_c: null }), preview({ spread_c: null })],
    });
    expect(score.converged).toBe(false);
    expect(score.previews_to_pass).toBeNull();
  });

  test("right first shot → previews_to_pass=1", () => {
    const score = scoreScenario(FINAL_SPEC, {
      scenario: FINAL_SPEC.slug,
      tool_calls: 2,
      status: "committed",
      wall_ms: 1,
      results: [preview({ spread_c: 5.5 })],
    });
    expect(score.previews_to_pass).toBe(1);
    expect(score.converged).toBe(true);
    expect(score.first_preview_content_pass).toBe(true);
  });
});

describe("scoreScenario · trajectory metrics (probe_before_author / dry_run_before_save)", () => {
  const SPEC2: LiveScenarioSpec = {
    slug: "traj",
    goal: "build something",
    connectors: ["x"],
    expect_judge_block: false,
    content_checks: [],
  };
  const obs = (tools: string[]): ScenarioObservation => ({
    scenario: SPEC2.slug,
    tool_calls: tools.length,
    status: "committed",
    wall_ms: 1,
    results: tools.map((t) => ({ tool: t, output: {} })),
  });

  test("probe before author → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["probe_connector", "author_workflow"])).probe_before_author,
    ).toBe(true);
  });
  test("author before any probe → false", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "probe_connector"])).probe_before_author,
    ).toBe(false);
  });
  test("no author step → null", () => {
    expect(
      scoreScenario(SPEC2, obs(["probe_connector", "list_connectors"])).probe_before_author,
    ).toBeNull();
  });
  test("dry_run before save → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["dry_run_workflow", "save_workflow_draft"])).dry_run_before_save,
    ).toBe(true);
  });
  test("save with no preceding dry_run → false", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "save_workflow_draft"])).dry_run_before_save,
    ).toBe(false);
  });
  test("no explicit save (auto-commit path) → true", () => {
    expect(
      scoreScenario(SPEC2, obs(["author_workflow", "dry_run_workflow"])).dry_run_before_save,
    ).toBe(true);
  });
});

describe("aggregateTrials · rates, not a single run", () => {
  const mk = (over: Partial<LiveScenarioScore>): LiveScenarioScore => ({
    scenario: "s",
    tool_calls: 10,
    llm_passes: 1,
    judge: "passes",
    wall_ms: 1,
    content_pass: true,
    previews: 1,
    first_preview_content_pass: true,
    converged: true,
    previews_to_pass: 1,
    probe_before_author: true,
    dry_run_before_save: true,
    expect_judge_block: false,
    status: "committed",
    targets: {
      pipeline_llm_calls_le_3: "PASS",
      single_preview: "PASS",
      tool_calls_le_15: "PASS",
      content_correct_first_preview: "PASS",
    },
    notes: [],
    ...over,
  });

  test("rates over isolated trials; NON-ISOLATED excluded; median previews_to_pass", () => {
    const agg = aggregateTrials([
      mk({ content_pass: true, previews_to_pass: 1 }),
      mk({ content_pass: false, converged: false, previews_to_pass: null }),
      mk({ content_pass: true, previews_to_pass: 3 }),
      mk({ notes: ["NON-ISOLATED: edit before preview"], content_pass: false }),
    ]);
    expect(agg.n_trials).toBe(3);
    expect(agg.excluded_non_isolated).toBe(1);
    expect(agg.content_pass_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.converged_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.median_previews_to_pass).toBe(2);
  });

  test("probe_before_author_rate counts only non-null (authored) trials", () => {
    const agg = aggregateTrials([
      mk({ probe_before_author: true }),
      mk({ probe_before_author: false }),
      mk({ probe_before_author: null }),
    ]);
    expect(agg.probe_before_author_rate).toBeCloseTo(1 / 2, 5);
  });
});
