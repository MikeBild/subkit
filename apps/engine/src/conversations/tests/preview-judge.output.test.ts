import { describe, expect, test } from "bun:test";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  buildJudgeDefinitionSummary,
  buildJudgeStepArtifacts,
  type JudgeStepArtifact,
  JudgeVerdictSchema,
  judgePreview,
  workflowDefinitionFingerprint,
} from "../preview-judge.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import {
  ctx,
  type JudgeEnvelope,
  makeCtx,
  usePreviewJudgeSetup,
} from "./preview-judge-fixtures.ts";

usePreviewJudgeSetup();

describe("preview judge · the judge sees the final output and the output_schema", () => {
  const GOAL = "Return the hottest day of the coming week: the date and its maximum temperature.";
  const RAW_FORECAST = {
    daily: { time: ["2026-06-22", "2026-06-23"], temperature_2m_max: [24.1, 31.2] },
  };
  const SCHEMA = {
    type: "object",
    required: ["hottest_day", "max_temp"],
    properties: { hottest_day: { type: "string" }, max_temp: { type: "number" } },
  };
  const forecastArtifacts: JudgeStepArtifact[] = [
    { step_id: "forecast", kind: "request", status: "succeeded", output_preview: RAW_FORECAST },
  ];

  function judgePrompt(): string {
    return getMockProvider().calls.find((c) => c.flow === "judge")?.last_user ?? "";
  }

  test("the prompt carries the final output as THE object to judge, the schema, and the raw-payload rule", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok",
      missing: [],
    });
    await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request)",
      step_artifacts: forecastArtifacts,
      final_output: { hottest_day: "2026-06-23", max_temp: 31.2 },
      output_schema: SCHEMA,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    const prompt = judgePrompt();
    expect(prompt).toContain(
      "Final output the caller receives (after output_transform) — THIS is the object to judge",
    );
    expect(prompt).toContain('"hottest_day": "2026-06-23"');
    expect(prompt).toContain("Declared output_schema the final output must satisfy");
    expect(prompt).toContain('"required": [');
    expect(prompt).toContain("RAW PAYLOAD IS NOT A RESULT");
    expect(prompt).toContain("BUILD INSTRUCTIONS ARE NOT OUTPUT");
    expect(Object.keys(JudgeVerdictSchema.shape)).toEqual(["reason", "missing", "verdict"]);
    expect(prompt).toContain("Write the reason first and derive the verdict from it");
    expect(prompt).toContain('"(not output_transform_function)"');
  });

  test("without a final output the prompt has no final-output section (held or absent output)", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok",
      missing: [],
    });
    await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request)",
      step_artifacts: forecastArtifacts,
      final_output: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(judgePrompt()).not.toContain("Final output the caller receives");
  });

  test('schema mismatch → "partial" with the violations in missing, even when the judge says "passes"', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Looks like the hottest day.",
      missing: [],
    });
    const outcome = await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request)",
      step_artifacts: forecastArtifacts,
      final_output: { hottest: "2026-06-23", max_temp: "31.2" },
      output_schema: SCHEMA,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(outcome.verdict).toBe("partial");
    if (outcome.verdict !== "partial") throw new Error("unreachable");
    expect(outcome.missing.some((m) => m.startsWith("$output/hottest_day"))).toBe(true);
    expect(outcome.missing.some((m) => m.startsWith("$output/max_temp"))).toBe(true);
  });

  test('a conforming final output keeps "passes"; a judge "failed" is never upgraded by a conforming schema', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok",
      missing: [],
    });
    const passes = await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request)",
      step_artifacts: forecastArtifacts,
      final_output: { hottest_day: "2026-06-23", max_temp: 31.2 },
      output_schema: SCHEMA,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(passes.verdict).toBe("passes");

    getMockProvider().generateOverrides.judge = () => ({
      verdict: "failed",
      reason: "raw payload",
      missing: ["hottest day"],
    });
    const failed = await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request)",
      step_artifacts: forecastArtifacts,
      final_output: { hottest_day: "2026-06-23", max_temp: 31.2 },
      output_schema: SCHEMA,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(failed.verdict).toBe("failed");
  });

  test("final_output_held skips the schema check (the held preview has no real final output)", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok",
      missing: [],
    });
    const outcome = await judgePreview({
      goal: GOAL,
      definition_summary: "- forecast (request); - send (held)",
      step_artifacts: forecastArtifacts,
      final_output: RAW_FORECAST,
      output_schema: SCHEMA,
      final_output_held: true,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });
    expect(outcome.verdict).toBe("passes");
  });

  test("dry_run_workflow passes output_schema through: a conforming green preview keeps its verdict, a violating one is repaired or downgraded", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok",
      missing: [],
    });
    const toolCtx = makeCtx({
      workflow: {
        name: "schema-through",
        slug: "schema-through",
        goal: GOAL,
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: 'return { hottest_day: "2026-06-23", max_temp: 31.2 };',
          },
        ],
        output_schema: SCHEMA,
      },
    } as unknown as DraftDocument);
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    expect((result.data as JudgeEnvelope).judge?.verdict).toBe("passes");
    expect(judgePrompt()).toContain("Declared output_schema the final output must satisfy");
  });
});

describe("preview judge · bounded-field coercion + retry (fail-open fix)", () => {
  const GOAL_PLAIN = "email me the droplet specs for each project";

  test("over-bounds verdict is CLAMPED, not skipped (no fail-open)", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "failed",
      reason: "x".repeat(2000),
      missing: Array.from({ length: 30 }, (_, i) => `${"m".repeat(500)}-${i}`),
    });

    const outcome = await judgePreview({
      goal: GOAL_PLAIN,
      definition_summary: "- shape (transform): collect specs",
      step_artifacts: [
        { step_id: "shape", kind: "transform", status: "succeeded", output_preview: { ok: true } },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("failed");
    if (outcome.verdict === "failed") {
      expect(outcome.reason.length).toBeLessThanOrEqual(800);
      expect(outcome.missing.length).toBeLessThanOrEqual(12);
      for (const m of outcome.missing) expect(m.length).toBeLessThanOrEqual(300);
    }
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(1);
  });

  test("a malformed object recovers on the ONE bounded retry", async () => {
    let n = 0;
    getMockProvider().generateOverrides.judge = () =>
      n++ === 0
        ? ({ nonsense: true } as never)
        : { verdict: "passes", reason: "ok on retry", missing: [] };

    const outcome = await judgePreview({
      goal: GOAL_PLAIN,
      definition_summary: "- shape (transform): collect specs",
      step_artifacts: [
        { step_id: "shape", kind: "transform", status: "succeeded", output_preview: { ok: true } },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("passes");
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(2);
  });

  test("malformed on both the call AND the retry → judge_unavailable (fail-open, never fail-closed)", async () => {
    getMockProvider().generateOverrides.judge = () => ({ no: "verdict" }) as never;

    const outcome = await judgePreview({
      goal: GOAL_PLAIN,
      definition_summary: "- shape (transform): collect specs",
      step_artifacts: [
        { step_id: "shape", kind: "transform", status: "succeeded", output_preview: { ok: true } },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome).toEqual({ verdict: "skipped", reason: "judge_unavailable" });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(2);
  });
});

describe("preview judge · helpers", () => {
  test("buildJudgeDefinitionSummary renders ids, kinds, descriptions", () => {
    const summary = buildJudgeDefinitionSummary([
      { id: "fetch", kind: "request", description: "List droplets" },
      { id: "shape", kind: "transform" },
    ]);
    expect(summary).toBe("- fetch (request): List droplets\n- shape (transform)");
  });

  test("buildJudgeStepArtifacts prioritizes transforms under budget pressure and keeps definition order", () => {
    const big = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`key_${i}`, "v".repeat(20)]),
    );
    const artifacts = buildJudgeStepArtifacts([
      { step_key: "fetch-1", kind: "request", status: "succeeded", output_preview: big },
      { step_key: "fetch-2", kind: "request", status: "succeeded", output_preview: big },
      { step_key: "fetch-3", kind: "request", status: "succeeded", output_preview: big },
      { step_key: "fetch-4", kind: "request", status: "succeeded", output_preview: big },
      {
        step_key: "shape",
        kind: "transform",
        status: "succeeded",
        output_preview: { html: "<p>final</p>" },
      },
    ]);
    expect(artifacts.some((a) => a.step_id === "shape")).toBe(true);
    expect(artifacts.length).toBeLessThan(5);
    expect(artifacts[artifacts.length - 1]?.step_id).toBe("shape");
  });

  test("buildJudgeStepArtifacts excludes skipped steps so the judge never reads a skipped step as missing data", () => {
    const artifacts = buildJudgeStepArtifacts([
      {
        step_key: "fetch",
        kind: "request",
        status: "succeeded",
        output_preview: { items: [1, 2, 3] },
      },
      {
        step_key: "send",
        kind: "request",
        status: "skipped",
        output_preview: undefined,
      },
      {
        step_key: "shape",
        kind: "transform",
        status: "succeeded",
        output_preview: { result: "ok" },
      },
    ]);
    const ids = artifacts.map((a) => a.step_id);
    expect(ids).not.toContain("send");
    expect(ids).toContain("fetch");
    expect(ids).toContain("shape");
  });

  test("buildJudgeStepArtifacts reads a held request duck-typed off request_meta", () => {
    const artifacts = buildJudgeStepArtifacts([
      {
        step_key: "send-email",
        kind: "request",
        status: "held",
        request_meta: { held_request: { to: "ops@example.com", body: "<p>report</p>" } },
      },
    ]);
    expect(artifacts[0]?.held_request).toEqual({ to: "ops@example.com", body: "<p>report</p>" });
  });

  test("workflowDefinitionFingerprint is stable under key order, distinct under content change", () => {
    const a = workflowDefinitionFingerprint({ name: "x", steps: [{ id: "a", kind: "wait" }] });
    const b = workflowDefinitionFingerprint({ steps: [{ kind: "wait", id: "a" }], name: "x" });
    const c = workflowDefinitionFingerprint({ name: "x", steps: [{ id: "b", kind: "wait" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
