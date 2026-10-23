import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { attributeCriticReview } from "../authoring-critic/attribution.ts";
import {
  type CriticAgentOutcome,
  classifyCriticVerdict,
  RENDERED_STEPS_CAP,
  type RunCriticAgentParams,
  renderDraftForCritic,
  reviewDraftWithCritic,
} from "../authoring-critic/critic-agent.ts";
import { consecutiveCriticRejectionsFromRows } from "../authoring-critic/streak.ts";
import type { WorkflowDraftDocument } from "../types.ts";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const CONVERSATION = "00000000-0000-4000-8000-0000000000c2";

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-critic-review-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/critic-review",
      NODE_ENV: "test",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

function draft(
  stepCount: number,
  extra: Partial<WorkflowDraftDocument> = {},
): WorkflowDraftDocument {
  return {
    name: "Digest",
    slug: "digest",
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i}`,
      kind: "transform",
      language: "javascript",
      expression: "return input;",
    })),
    ...extra,
  };
}

function criticSamples(): Array<{ labels: Record<string, string>; value: number }> {
  const entry = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.CRITIC_RUNS_TOTAL);
  return (entry?.samples ?? []) as Array<{ labels: Record<string, string>; value: number }>;
}

function countFor(result: string, tool: string): number {
  return criticSamples()
    .filter((s) => s.labels.result === result && s.labels.tool === tool)
    .reduce((acc, s) => acc + s.value, 0);
}

describe("renderDraftForCritic", () => {
  test("leads with the goal and keeps output_schema even when the steps are truncated", () => {
    const big = draft(1, {
      output_schema: { type: "object", required: ["hottest_day"] },
      steps: [{ id: "huge", kind: "transform", expression: "x".repeat(RENDERED_STEPS_CAP * 2) }],
    });
    const text = renderDraftForCritic(big, "Report the hottest day of the week");
    expect(text.indexOf("Report the hottest day of the week")).toBeLessThan(
      text.indexOf("Steps (1)"),
    );
    expect(text).toContain('"required":["hottest_day"]');
    expect(text).toContain("[truncated; original");
  });

  test("says explicitly when the draft carries no goal", () => {
    expect(renderDraftForCritic(draft(1))).toContain("Goal: not recorded");
    expect(renderDraftForCritic(draft(1))).toContain("Declared output_schema: none");
  });

  test("shows a JavaScript final transform so the output can be checked against the goal", () => {
    const text = renderDraftForCritic(
      draft(1, { output_transform_function: "return input.slice(0, 5);" }),
      "five newest",
    );
    expect(text).toContain("output_transform_function: return input.slice(0, 5);");
  });
});

describe("attributeCriticReview", () => {
  test("a critic review of an earlier pass is not attributed to the returned definition", () => {
    expect(
      attributeCriticReview({
        review: { result: "reject", gating_reason: "step_count", pass: 1 },
        returnedPass: 2,
        deadlineExceeded: false,
      }),
    ).toEqual({
      result: "reject",
      gating_reason: "step_count",
      reviewed_pass: 1,
      returned_pass: 2,
      reviewed_returned_definition: false,
    });
  });

  test("a swap back to the reviewed candidate is attributed to the returned definition", () => {
    const report = attributeCriticReview({
      review: { result: "reject", gating_reason: "step_count", pass: 1 },
      returnedPass: 1,
      deadlineExceeded: false,
    });
    expect(report).toMatchObject({ reviewed_pass: 1, reviewed_returned_definition: true });
  });

  test("a pipeline whose critic never ran says why", () => {
    expect(
      attributeCriticReview({ review: null, returnedPass: 2, deadlineExceeded: false }),
    ).toEqual({ result: "not_reached", reason: "static_findings", returned_pass: 2 });
    expect(
      attributeCriticReview({ review: null, returnedPass: 1, deadlineExceeded: true }),
    ).toMatchObject({ reason: "deadline_exceeded" });
    expect(
      attributeCriticReview({ review: null, returnedPass: null, deadlineExceeded: false }),
    ).toMatchObject({ reason: "no_definition", returned_pass: null });
  });
});

describe("consecutiveCriticRejectionsFromRows", () => {
  const reject = { repairs: ["fix"], rationale: "r", gating_reason: "step_count" };

  test("counts author and edit rejections across other tools and skips pending rows", () => {
    expect(
      consecutiveCriticRejectionsFromRows([
        { tool: "author_workflow", output: null },
        { tool: "dry_run_workflow", output: { ok: true } },
        { tool: "edit_workflow_patch", output: { critic_rejection: reject } },
        { tool: "inspect_workflow_draft", output: { steps: 3 } },
        { tool: "author_workflow", output: { critic_rejection: reject } },
        { tool: "edit_workflow_patch", output: { critic: { result: "pass" } } },
        { tool: "author_workflow", output: { critic_rejection: reject } },
      ]),
    ).toBe(2);
  });

  test("fail_open and failed calls neither count nor reset the streak", () => {
    expect(
      consecutiveCriticRejectionsFromRows([
        { tool: "edit_workflow_patch", output: { critic: { result: "fail_open" } } },
        { tool: "edit_workflow_patch", output: { error_code: "patch_invalid" } },
        { tool: "author_workflow", output: { critic_rejection: reject } },
        { tool: "author_workflow", output: { critic_rejection: reject } },
      ]),
    ).toBe(2);
  });

  test("a skipped or passing review resets the streak", () => {
    expect(
      consecutiveCriticRejectionsFromRows([
        { tool: "author_workflow", output: { critic: { result: "skipped_min_steps" } } },
        { tool: "author_workflow", output: { critic_rejection: reject } },
      ]),
    ).toBe(0);
  });
});

describe("reviewDraftWithCritic", () => {
  beforeAll(async () => {
    await ensureConfigLoaded();
  });

  beforeEach(() => {
    resetMetricsRegistryForTests();
  });

  afterAll(async () => {
    await setConfigKey(["llm", "critic", "enabled"], false);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    await setConfigKey(["llm", "critic", "max_consecutive_rejections"], 3);
  });

  async function enable(): Promise<void> {
    await setConfigKey(["llm", "critic", "enabled"], true);
    await setConfigKey(["llm", "critic", "min_steps"], 3);
    await setConfigKey(["llm", "critic", "max_consecutive_rejections"], 3);
  }

  const agentCalls: RunCriticAgentParams[] = [];

  function agentReturning(verdict: unknown) {
    return async (p: RunCriticAgentParams): Promise<CriticAgentOutcome> => {
      agentCalls.push(p);
      return classifyCriticVerdict(verdict);
    };
  }

  function base(stepCount: number, streak = 0) {
    let streakReads = 0;
    agentCalls.length = 0;
    return {
      params: {
        tool: "edit_workflow_patch" as const,
        draft: draft(stepCount, { output_schema: { type: "array" } }),
        goal: "List the five newest repos by name",
        tenant_id: TENANT,
        conversation_id: CONVERSATION,
        recentDriftCount: 0,
        loadConsecutiveRejections: async () => {
          streakReads += 1;
          return streak;
        },
      },
      streakReads: () => streakReads,
    };
  }

  test("disabled is reported as skipped_disabled without reading the streak", async () => {
    await setConfigKey(["llm", "critic", "enabled"], false);
    const { params, streakReads } = base(5);
    const outcome = await reviewDraftWithCritic(params);
    expect(outcome.result).toBe("skipped_disabled");
    expect(streakReads()).toBe(0);
    expect(countFor("skipped_disabled", "edit_workflow_patch")).toBe(1);
    expect(agentCalls).toHaveLength(0);
  });

  test("below min_steps is reported as skipped_min_steps", async () => {
    await enable();
    const outcome = await reviewDraftWithCritic(base(2).params);
    expect(outcome.result).toBe("skipped_min_steps");
    expect(countFor("skipped_min_steps", "edit_workflow_patch")).toBe(1);
  });

  test("a full rejection streak is reported as skipped_streak", async () => {
    await enable();
    const outcome = await reviewDraftWithCritic(base(5, 3).params);
    expect(outcome.result).toBe("skipped_streak");
    expect(outcome.gating_reason).toBe("anti_loop");
    expect(countFor("skipped_streak", "edit_workflow_patch")).toBe(1);
  });

  test("a rejection carries its repairs and the critic sees the goal and output_schema", async () => {
    await enable();
    const outcome = await reviewDraftWithCritic({
      ...base(4).params,
      runAgent: agentReturning({
        passed: false,
        repairs: ["Sort by created_at before taking five"],
        rationale: "order drift",
      }),
    });
    expect(outcome.result).toBe("reject");
    expect(outcome.repairs).toEqual(["Sort by created_at before taking five"]);
    const call = agentCalls[0];
    if (!call) throw new Error("critic agent was not called");
    expect(call.goal).toBe("List the five newest repos by name");
    const prompt = renderDraftForCritic(call.draft, call.goal);
    expect(prompt).toContain("List the five newest repos by name");
    expect(prompt).toContain('Declared output_schema:\n{"type":"array"}');
    expect(countFor("reject", "edit_workflow_patch")).toBe(1);
  });

  test("a pass is counted as pass", async () => {
    await enable();
    const outcome = await reviewDraftWithCritic({
      ...base(4).params,
      tool: "author_workflow",
      runAgent: agentReturning({ passed: true, repairs: [], rationale: "matches the goal" }),
    });
    expect(outcome.result).toBe("pass");
    expect(countFor("pass", "author_workflow")).toBe(1);
  });

  test("an LLM failure, a missing or invalid verdict and a rejection without repairs are fail_open, never pass", async () => {
    await enable();
    const agents: Array<(p: RunCriticAgentParams) => Promise<CriticAgentOutcome>> = [
      async () => ({ outcome: "fail_open", reason: "call_failed: provider down" }),
      agentReturning(undefined),
      agentReturning({ passed: "maybe" }),
      agentReturning({ passed: false, repairs: [], rationale: "vague" }),
    ];
    for (const runAgent of agents) {
      const outcome = await reviewDraftWithCritic({ ...base(4).params, runAgent });
      expect(outcome.result).toBe("fail_open");
      expect(outcome.repairs).toEqual([]);
    }
    expect(countFor("fail_open", "edit_workflow_patch")).toBe(4);
    expect(countFor("pass", "edit_workflow_patch")).toBe(0);
  });

  test("a streak read failure is fail_open", async () => {
    await enable();
    const outcome = await reviewDraftWithCritic({
      ...base(4).params,
      loadConsecutiveRejections: async () => {
        throw new Error("db down");
      },
    });
    expect(outcome.result).toBe("fail_open");
    expect(outcome.fail_open_reason).toContain("db down");
  });
});
