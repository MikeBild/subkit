import { describe, expect, test } from "bun:test";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  normalizeDraftDocument,
  startNewWorkflowDraft,
  withWorkflowDraft,
} from "../authoring-state/index.ts";
import { type JudgeStepArtifact, judgePreview } from "../preview-judge.ts";
import { ctx, GOAL, usePreviewJudgeSetup } from "./preview-judge-fixtures.ts";

usePreviewJudgeSetup();

describe("preview judge · goal stash round-trip", () => {
  test("goal on the workflow draft survives normalizeDraftDocument", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "g", slug: "g", goal: GOAL, steps: [] },
    });
    expect(normalized.workflow.goal).toBe(GOAL);
  });

  test("judge_breaker (blocks-since-commit + verdict memo) survives the state normalize round-trip", () => {
    const memo = {
      fingerprint: "abc123",
      verdict: "failed" as const,
      reason: "still empty",
      missing: ["names"],
    };
    const normalized = normalizeDraftDocument({
      workflow: { name: "g", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { blocks_since_commit: 2, last_verdict: memo },
      },
    });
    expect(normalized.state?.judge_breaker).toEqual({
      blocks_since_commit: 2,
      last_verdict: memo,
    });
  });

  test("a goal change resets blocks_since_commit (no carry-over across goals)", () => {
    const atCap = normalizeDraftDocument({
      workflow: { name: "A", slug: "a", goal: "goal A", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: {
          blocks_since_commit: 2,
          last_verdict: { fingerprint: "fpA", verdict: "failed", reason: "x", missing: ["a"] },
        },
      },
    });
    expect(atCap.state?.judge_breaker?.blocks_since_commit).toBe(2);
    const pivoted = withWorkflowDraft(
      atCap,
      { name: "B", slug: "b", goal: "goal B", steps: [] },
      "workflow_authored_one_shot",
    );
    expect(pivoted.state?.judge_breaker ?? null).toBeNull();
  });

  test("a same-goal edit does NOT reset blocks_since_commit (convergence preserved)", () => {
    const atOne = normalizeDraftDocument({
      workflow: { name: "A", slug: "a", goal: "same goal", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { blocks_since_commit: 1, last_verdict: null },
      },
    });
    const edited = withWorkflowDraft(
      atOne,
      { name: "A", slug: "a", goal: "same goal", steps: [{ id: "x", kind: "transform" }] as never },
      "edit",
    );
    expect(edited.state?.judge_breaker?.blocks_since_commit).toBe(1);
  });

  test("startNewWorkflowDraft clears the judge breaker", () => {
    const withBreaker = normalizeDraftDocument({
      workflow: { name: "A", slug: "a", goal: "goal A", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { blocks_since_commit: 2, last_verdict: null },
      },
    });
    const fresh = startNewWorkflowDraft(withBreaker);
    expect(fresh.state?.judge_breaker ?? null).toBeNull();
  });

  test("an earlier { fingerprint, blocks } judge_breaker seeds blocks_since_commit", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "g", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { fingerprint: "earlier", blocks: 2 },
      },
    });
    expect(normalized.state?.judge_breaker?.blocks_since_commit).toBe(2);
    expect(normalized.state?.judge_breaker?.last_verdict ?? null).toBeNull();
  });
});

describe("preview judge · filter-violation downgrade wiring", () => {
  const FILTER_GOAL = "Digest of OFFLINE (not connected) chargers only.";

  test('judge "passes" + excluded value present in output → downgraded to "partial"', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Looks like a charger digest.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: FILTER_GOAL,
      definition_summary: "- shape (transform): build digest",
      step_artifacts: [
        {
          step_id: "shape",
          kind: "transform",
          status: "succeeded",
          output_preview:
            "<table><tr><td>SN-CP-1001</td><td>HEALTHY</td><td>connected</td></tr></table>",
        },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("partial");
    if (outcome.verdict === "partial") {
      expect(outcome.missing).toContain("connected");
    }
  });

  test('judge "passes" + excluded value absent (filter applied) → stays "passes"', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Only offline chargers listed.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: FILTER_GOAL,
      definition_summary: "- shape (transform): build digest",
      step_artifacts: [
        {
          step_id: "shape",
          kind: "transform",
          status: "succeeded",
          output_preview: "<table><tr><td>SN-CP-1001</td><td>offline</td></tr></table>",
        },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("passes");
  });
});

describe("preview judge · format-fidelity downgrade wiring", () => {
  const MARKDOWN_GOAL = "return a markdown table that ranks the top cities by population";

  const jsonArrayArtifacts: JudgeStepArtifact[] = [
    {
      step_id: "shape",
      kind: "transform",
      status: "succeeded",
      output_preview: [
        { rank: 1, city: "Berlin" },
        { rank: 2, city: "Hamburg" },
      ],
    },
  ];

  const markdownTableArtifacts: JudgeStepArtifact[] = [
    {
      step_id: "shape",
      kind: "transform",
      status: "succeeded",
      output_preview: "| rank | city |\n| ---: | --- |\n| 1 | Berlin |\n| 2 | Hamburg |",
    },
  ];

  test('judge returns "passes" + markdown-table goal + JSON-array output → downgraded to "partial" with non-empty missing', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "The data looks correct.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- shape (transform): rank cities",
      step_artifacts: jsonArrayArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("partial");
    if (outcome.verdict === "partial") {
      expect(outcome.missing.length).toBeGreaterThan(0);
    }
  });

  test('judge returns "passes" + markdown-table goal + proper markdown table output → stays "passes"', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Output is a well-formed markdown table.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- shape (transform): rank cities",
      step_artifacts: markdownTableArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("passes");
  });

  test("markdown in an intermediate STEP but final_output is structured → downgraded (judge checks final_output, NOT step artifacts)", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "The rendered step looks right.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- render (transform): build table; - wrap: output_transform",
      step_artifacts: markdownTableArtifacts,
      final_output: [
        { rank: 1, city: "Berlin", max_temp_c: 25 },
        { rank: 2, city: "Hamburg", max_temp_c: 23 },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("partial");
    if (outcome.verdict === "partial") {
      expect(outcome.missing.length).toBeGreaterThan(0);
    }
  });

  test('final_output IS a markdown string → stays "passes" even when step artifacts are structured', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Final output is a markdown table.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- collect (transform); - render: output_transform",
      step_artifacts: jsonArrayArtifacts,
      final_output: "| rank | city |\n| ---: | --- |\n| 1 | Berlin |\n| 2 | Hamburg |",
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("passes");
  });

  test('judge returns "passes" + plain-data goal naming NO format → stays "passes" regardless of output shape (no false block)', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "All droplet specs are present.",
      missing: [],
    });

    const outcome = await judgePreview({
      goal: "email me the droplet specs for each project",
      definition_summary: "- shape (transform): collect specs",
      step_artifacts: jsonArrayArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("passes");
  });

  test('judge returns "partial" → passed through unchanged (guard only acts on "passes")', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "partial",
      reason: "Some city names are missing.",
      missing: ["city names for 3 rows are empty"],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- shape (transform): rank cities",
      step_artifacts: jsonArrayArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("partial");
    if (outcome.verdict === "partial") {
      expect(outcome.reason).toContain("city names");
    }
  });

  test('judge returns "failed" → passed through unchanged (guard only acts on "passes")', async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "failed",
      reason: "Output is entirely empty.",
      missing: ["all city data"],
    });

    const outcome = await judgePreview({
      goal: MARKDOWN_GOAL,
      definition_summary: "- shape (transform): rank cities",
      step_artifacts: jsonArrayArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    expect(outcome.verdict).toBe("failed");
  });
});
