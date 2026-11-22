import { describe, expect, test } from "bun:test";
import {
  aggregateTrials,
  BENCHMARK_TARGETS,
  bindScenarioInputs,
  buildLiveReport,
  evaluateBenchmarkTargets,
  extractJudgeVerdict,
  extractLlmPasses,
  extractPreviews,
  LIVE_SCENARIOS,
  type LiveScenarioSpec,
  previewWasAutoRepaired,
  runContentChecks,
  type ScenarioObservation,
  scenarioPassed,
  scoreScenario,
  specNeedsRecipient,
} from "../live-report.ts";
import { CLARIFY_SPEC, call, observation, turn } from "./live-report-fixtures.ts";

const SPEC: LiveScenarioSpec = {
  slug: "droplet-specs-email",
  kind: "authoring",
  goal: "Email ops@acme.test the droplet specs.",
  connectors: ["digitalocean", "gmail"],
  content_checks: [
    { name: "recipient", pattern: "ops@acme\\.test" },
    { name: "specs", pattern: "vcpu", flags: "i" },
  ],
};

function happyObservation(): ScenarioObservation {
  return observation(SPEC, [
    turn(
      [
        call("author_workflow", { goal: "x" }, { attempts: 1, next: "dry_run_workflow" }),
        call(
          "dry_run_workflow",
          {},
          {
            judge: { verdict: "passes", reason: "ok", missing: [] },
            step_trace: [
              {
                step_id: "send",
                held: true,
                held_request: {
                  body: { to: "ops@acme.test", html: "<p>web — 2 vCPU / 4GB / 80GB</p>" },
                },
              },
            ],
          },
        ),
        call("save_workflow_draft", {}, { ok: true, data: { workflow_id: "wf_1" } }),
        call("list_connectors"),
      ],
      "committed",
    ),
  ]);
}

describe("extraction helpers", () => {
  test("extractLlmPasses reads attempts off the author_workflow envelope (bare or {ok,data}-wrapped)", () => {
    expect(extractLlmPasses([call("author_workflow", {}, { attempts: 2 })])).toBe(2);
    expect(
      extractLlmPasses([call("author_workflow", {}, { ok: true, data: { attempts: 1 } })]),
    ).toBe(1);
    expect(extractLlmPasses([call("dry_run_workflow", {}, { attempts: 9 })])).toBeNull();
  });

  test("extractPreviews keeps dry_run_workflow envelopes in call order", () => {
    const previews = extractPreviews([
      call("dry_run_workflow", {}, { judge: { verdict: "failed" } }),
      call("list_connectors"),
      call("dry_run_workflow", {}, { judge: { verdict: "passes" } }),
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

  test("previewWasAutoRepaired reads the preview.auto_repaired warning or the auto_repair block", () => {
    expect(
      previewWasAutoRepaired({
        warnings: [{ step_key: "$output", code: "preview.auto_repaired", message: "m" }],
      }),
    ).toBe(true);
    expect(previewWasAutoRepaired({ auto_repair: { site: "output_transform", attempts: 1 } })).toBe(
      true,
    );
    expect(previewWasAutoRepaired({ warnings: [{ code: "scope.drift" }] })).toBe(false);
    expect(previewWasAutoRepaired(undefined)).toBe(false);
  });
});

describe("bindScenarioInputs", () => {
  const TEMPLATE: LiveScenarioSpec = {
    slug: "t",
    kind: "authoring",
    goal: "Email {recipient} the report.",
    answer_turns: ["Send it to {recipient}."],
    connectors: [],
    content_checks: [{ name: "recipient present", pattern: "{recipient}" }],
  };

  test("replaces {recipient} in goal and answer turns verbatim, in patterns regex-escaped", () => {
    const bound = bindScenarioInputs(TEMPLATE, { recipient: "ops+eval@acme.test" });
    expect(bound.goal).toBe("Email ops+eval@acme.test the report.");
    expect(bound.answer_turns).toEqual(["Send it to ops+eval@acme.test."]);
    expect(bound.content_checks[0]?.pattern).toBe("ops\\+eval@acme\\.test");
    expect(new RegExp(bound.content_checks[0]?.pattern ?? "").test("to ops+eval@acme.test")).toBe(
      true,
    );
    expect(new RegExp(bound.content_checks[0]?.pattern ?? "").test("opsXeval@acmeXtest")).toBe(
      false,
    );
  });

  test("leaves the source spec untouched and reports which specs need a recipient", () => {
    bindScenarioInputs(TEMPLATE, { recipient: "a@b.test" });
    expect(TEMPLATE.goal).toContain("{recipient}");
    expect(specNeedsRecipient(TEMPLATE)).toBe(true);
    expect(specNeedsRecipient(CLARIFY_SPEC)).toBe(false);
  });
});

describe("benchmark targets (authoring)", () => {
  const base = {
    llm_passes: 1,
    previews: 1,
    tool_calls: 10,
    first_preview_content_pass: true,
  };

  test("all targets PASS on the happy shape", () => {
    expect(Object.values(evaluateBenchmarkTargets(base, []))).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
      "PASS",
    ]);
  });

  test("pipeline_llm_calls_le_3 boundary: 3 passes, 4 fails, missing fails", () => {
    expect(
      evaluateBenchmarkTargets(
        { ...base, llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max },
        [],
      ).pipeline_llm_calls_le_3,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets(
        {
          ...base,
          llm_passes: BENCHMARK_TARGETS.pipeline_llm_calls_max + 1,
        },
        [],
      ).pipeline_llm_calls_le_3,
    ).toBe("FAIL");
    expect(
      evaluateBenchmarkTargets({ ...base, llm_passes: null }, []).pipeline_llm_calls_le_3,
    ).toBe("FAIL");
  });

  test("single_preview demands exactly one preview", () => {
    expect(evaluateBenchmarkTargets({ ...base, previews: 0 }, []).single_preview).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, previews: 2 }, []).single_preview).toBe("FAIL");
  });

  test("tool_calls_le_15 boundary: 15 passes, 16 fails, 0 fails (nothing ran)", () => {
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max }, [])
        .tool_calls_le_15,
    ).toBe("PASS");
    expect(
      evaluateBenchmarkTargets({ ...base, tool_calls: BENCHMARK_TARGETS.tool_calls_max + 1 }, [])
        .tool_calls_le_15,
    ).toBe("FAIL");
    expect(evaluateBenchmarkTargets({ ...base, tool_calls: 0 }, []).tool_calls_le_15).toBe("FAIL");
  });
});

describe("scoreScenario · authoring", () => {
  test("happy path: stable row shape with every target PASS", () => {
    const score = scoreScenario(SPEC, happyObservation());
    expect(score).toMatchObject({
      scenario: "droplet-specs-email",
      kind: "authoring",
      tool_calls: 4,
      llm_passes: 1,
      judge: "passes",
      wall_ms: 1,
      content_pass: true,
      previews: 1,
      first_preview_content_pass: true,
      guard_fired: null,
      auto_repaired_first_preview: false,
    });
    expect(Object.values(score.targets)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("content failure on the first preview fails content_pass even when the judge passed", () => {
    const obs = happyObservation();
    const preview = obs.results[1]?.output as Record<string, unknown>;
    preview.step_trace = [{ step_id: "send", held_request: { body: { to: "", html: "" } } }];
    const score = scoreScenario(SPEC, obs);
    expect(score.content_pass).toBe(false);
    expect(score.first_preview_content_pass).toBe(false);
    expect(score.targets).toMatchObject({ content_correct_first_preview: "FAIL" });
    expect(score.notes.join(" ")).toContain("failed content checks");
    expect(scenarioPassed(score)).toBe(false);
  });

  test("an auto-repaired first preview is recorded on the score and noted as AUTO-REPAIRED", () => {
    const obs = happyObservation();
    const preview = obs.results[1]?.output as Record<string, unknown>;
    preview.warnings = [
      { step_key: "$output", code: "preview.auto_repaired", message: "repaired" },
    ];
    const score = scoreScenario(SPEC, obs);
    expect(score.auto_repaired_first_preview).toBe(true);
    expect(score.notes.some((n) => n.startsWith("AUTO-REPAIRED"))).toBe(true);
    expect(scenarioPassed(score)).toBe(true);
  });

  test("errored run scores as failed with the error in notes and no crash", () => {
    const score = scoreScenario(SPEC, {
      ...observation(SPEC, []),
      status: "error",
      wall_ms: 12,
      error: "connect ECONNREFUSED",
    });
    expect(score.content_pass).toBe(false);
    expect(score.llm_passes).toBeNull();
    expect(score.previews).toBe(0);
    expect(Object.values(score.targets)).toEqual(["FAIL", "FAIL", "FAIL", "FAIL", "PASS"]);
    expect(score.notes.join(" ")).toContain("ECONNREFUSED");
  });
});

describe("buildLiveReport", () => {
  test("aggregates pass/fail, keeps the stable per-scenario keys and carries trials and cleanup", () => {
    const good = scoreScenario(SPEC, happyObservation());
    const bad = scoreScenario(SPEC, { ...observation(SPEC, []), status: "error", error: "boom" });
    const report = buildLiveReport({
      scores: [good, bad],
      engine_host: "engine.example.com",
      started_at: "2026-06-12T00:00:00.000Z",
      finished_at: "2026-06-12T00:05:00.000Z",
      trials: [aggregateTrials([good, bad])],
      cleanup: { deleted: 3, failures: [] },
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.trials?.[0]?.pass_rate).toBeCloseTo(0.5, 5);
    expect(report.cleanup).toEqual({ deleted: 3, failures: [] });
    for (const key of [
      "scenario",
      "kind",
      "tool_calls",
      "llm_passes",
      "judge",
      "wall_ms",
      "content_pass",
      "previews",
      "guard_fired",
      "auto_repaired_first_preview",
      "targets",
    ]) {
      expect(Object.keys(report.scenarios[0] ?? {})).toContain(key);
    }
  });
});

describe("live scenario specs", () => {
  test("bounded set, unique slugs, exactly two clarification scenarios of which one answers with a placeholder", () => {
    expect(LIVE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(LIVE_SCENARIOS.length).toBeLessThanOrEqual(10);
    expect(new Set(LIVE_SCENARIOS.map((s) => s.slug)).size).toBe(LIVE_SCENARIOS.length);
    const clarifications = LIVE_SCENARIOS.filter((s) => s.kind === "clarification");
    expect(clarifications.map((s) => s.slug).sort()).toEqual([
      "underspecified-asks-first",
      "underspecified-placeholder-rejected",
    ]);
    expect(
      clarifications.filter((s) => (s.answer_turns?.length ?? 0) > 0).map((s) => s.slug),
    ).toEqual(["underspecified-placeholder-rejected"]);
    expect(LIVE_SCENARIOS.some((s) => s.slug === "underspecified-judge-block")).toBe(false);
  });

  test("every content check compiles once {recipient} is bound", () => {
    for (const raw of LIVE_SCENARIOS) {
      const spec = bindScenarioInputs(raw, { recipient: "ops@acme.test" });
      for (const check of spec.content_checks) {
        expect(() => new RegExp(check.pattern, check.flags ?? "")).not.toThrow();
      }
    }
  });

  test("the droplet-specs scenario takes its recipient from the runner, never a fabricated address", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "droplet-specs-email");
    expect(spec?.goal).toContain("{recipient}");
    expect(spec?.goal).not.toContain("example.com");
    expect(specNeedsRecipient(spec as LiveScenarioSpec)).toBe(true);
    expect(LIVE_SCENARIOS.filter(specNeedsRecipient).map((s) => s.slug)).toEqual([
      "droplet-specs-email",
    ]);
  });

  test("the placeholder-rejected scenario answers with the placeholder the engine must refuse", () => {
    const spec = LIVE_SCENARIOS.find((s) => s.slug === "underspecified-placeholder-rejected");
    expect(spec?.answer_turns).toEqual([
      "Send it to test@example.com by a plain HTTP POST to https://hooks.example.com/report with a JSON body {to, subject, rows}. The data is the first 5 posts from https://jsonplaceholder.typicode.com/posts (id and title). Subject: Post report. No schedule, I run it on demand. That is everything, build and preview it now.",
    ]);
    expect(spec?.connectors).toEqual([]);
  });
});
