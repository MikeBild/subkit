import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { SPEC_GOAL_GUIDANCE } from "../authoring-spec.ts";
import {
  normalizeDraftDocument,
  startNewWorkflowDraft,
  withWorkflowDraft,
} from "../authoring-state.ts";
import {
  buildJudgeDefinitionSummary,
  buildJudgeStepArtifacts,
  JUDGE_BREAKER_MAX_BLOCKS,
  type JudgeStepArtifact,
  JudgeVerdictSchema,
  judgePreview,
  workflowDefinitionFingerprint,
} from "../preview-judge.ts";
import { runPreviewJudgeGate } from "../preview-judge-gate.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x10d_6e);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("preview-judge");
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

interface JudgeEnvelope {
  auto_committed?: boolean;
  classification?: string;
  judge?: { verdict: string; reason: string; missing?: string[]; next_action?: string };
  judge_done?: {
    committed_as_is?: boolean;
    escalate?: boolean;
    attempts?: number;
    missing?: string[];
    next_action?: string;
  };
  error_code?: string;
  warnings?: Array<{ code: string; message: string }>;
  next_best_actions?: string[];
}

function makeCtx(
  initial: DraftDocument,
  opts?: {
    surface?: ToolContext["surface"];
    permission_mode?: ToolContext["permission_mode"];
  },
): ToolContext & { current: () => DraftDocument } {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    ...(opts?.surface ? { surface: opts.surface } : {}),
    ...(opts?.permission_mode ? { permission_mode: opts.permission_mode } : {}),
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    current: () => draft,
  };
}

function wrongContentDraft(slug: string, goal: string | null): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      ...(goal ? { goal } : {}),
      steps: [
        {
          id: "shape-email",
          kind: "transform",
          language: "javascript",
          expression: `return { html: "<p>Project: ()</p>", projects: [{ name: "" }] };`,
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

const GOAL =
  "Email me the DigitalOcean resources per project: include project names and droplet specs (CPU, memory, disk).";

const FAILED_VERDICT = {
  verdict: "failed" as const,
  reason: "Project names are empty and droplet specs are absent from the previewed email.",
  missing: ["project names are empty strings", "droplet specs (CPU/memory/disk) absent"],
};

describe("preview judge · dry_run_workflow wiring", () => {
  test("wrong-content fixture: failed verdict blocks auto-commit, verdict + missing ride the result", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-blocks", GOAL));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(false);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBeUndefined();
    expect(data.classification).toBe("needs_repair");
    expect(data.judge?.verdict).toBe("failed");
    expect(data.judge?.missing).toEqual(FAILED_VERDICT.missing);
    expect(data.next_best_actions).toContain("edit_workflow_patch");
    const warning = (data.warnings ?? []).find((w) => w.code === "judge_goal_mismatch");
    expect(warning?.message).toContain("project names are empty strings");

    expect(toolCtx.current().latest_preview?.requires_repair).toBe(true);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);
  });

  test("passing fixture in ask mode requires an explicit save", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Output contains project names and droplet specs.",
      missing: [],
    });
    const toolCtx = makeCtx(wrongContentDraft("judge-passes", GOAL));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(false);
    expect((data as { save_required?: boolean }).save_required).toBe(true);
    expect(data.next_best_actions).toEqual(["save_workflow_draft"]);
    expect(data.judge?.verdict).toBe("passes");
  });

  test("passing fixture in auto mode commits and an unchanged re-run is idempotent", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Output contains project names and droplet specs.",
      missing: [],
    });
    const toolCtx = makeCtx(wrongContentDraft("judge-passes-idempotent", GOAL), {
      permission_mode: "auto",
    });

    const first = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(first.ok).toBe(true);
    const firstData = first.data as JudgeEnvelope & {
      workflow_id?: string;
      version_changed?: boolean;
    };
    expect(firstData.auto_committed).toBe(true);
    expect(firstData.version_changed).toBe(true);
    expect(first.committed_workflow_id).toBe(firstData.workflow_id);

    const second = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(second.ok).toBe(true);
    const secondData = second.data as JudgeEnvelope & {
      already_persisted?: boolean;
      version_changed?: boolean;
      workflow_id?: string;
    };
    expect(secondData.already_persisted).toBe(true);
    expect(secondData.auto_committed).toBe(false);
    expect(secondData.version_changed).toBe(false);
    expect(secondData.workflow_id).toBe(firstData.workflow_id);
    expect(second.committed_workflow_id).toBeUndefined();
  });

  test("goal absent: judge skipped with no_goal, green preview is NOT auto-committed", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-no-goal", null));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(false);
    expect((data as { save_required?: boolean }).save_required).toBe(true);
    expect((data as { next_best_actions?: string[] }).next_best_actions).toEqual([
      "save_workflow_draft",
    ]);
    expect(data.judge).toEqual({
      verdict: "skipped",
      reason: "no_goal",
      next_action: SPEC_GOAL_GUIDANCE,
    });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(0);
  });

  test("backgrounded MCP surface does not bypass the explicit save gate", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-unattended-mcp", null), {
      surface: "mcp",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & { save_required?: boolean };
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
    expect(data.next_best_actions).toEqual(["save_workflow_draft"]);
    expect(data.judge).toEqual({
      verdict: "skipped",
      reason: "no_goal",
      next_action: SPEC_GOAL_GUIDANCE,
    });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(0);
  });

  test("a request not to save keeps a green auto-mode preview unsaved", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-do-not-save", null), {
      permission_mode: "auto",
    });
    toolCtx.recentUserMessage = "Prüfe ihn mit einer Vorschau, speichere ihn aber nicht.";

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & {
      next_best_actions?: string[];
      save_required?: boolean;
    };
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).not.toBe(true);
    expect(data.next_best_actions).toEqual([]);
    expect(result.committed_workflow_id).toBeUndefined();
  });

  test('UNATTENDED (permission_mode "auto"): green + no-goal preview AUTO-COMMITS', async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-unattended-auto", null), {
      permission_mode: "auto",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & { save_required?: boolean };
    expect(data.auto_committed).toBe(true);
    expect(data.save_required).toBeUndefined();
    expect(data.judge).toEqual({
      verdict: "skipped",
      reason: "no_goal",
      next_action: SPEC_GOAL_GUIDANCE,
    });
  });

  test("UNATTENDED does NOT weaken the quality gate: a failed verdict STILL blocks the auto-commit", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-unattended-blocks", GOAL), {
      surface: "mcp",
      permission_mode: "auto",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(false);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBeUndefined();
    expect(data.classification).toBe("needs_repair");
    expect(data.judge?.verdict).toBe("failed");
    expect(data.next_best_actions).toContain("edit_workflow_patch");
    expect(toolCtx.current().latest_preview?.requires_repair).toBe(true);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);
  });

  test("ATTENDED (sk_interactive): green + no-goal preview is UNCHANGED — defers to explicit save", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-attended-nogoal", null), {
      surface: "sk_interactive",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & { save_required?: boolean };
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
    expect(data.next_best_actions).toEqual(["save_workflow_draft"]);
    expect(data.judge).toEqual({
      verdict: "skipped",
      reason: "no_goal",
      next_action: SPEC_GOAL_GUIDANCE,
    });
  });

  test("judge infrastructure error, human present: skipped with judge_unavailable and NOT auto-committed", async () => {
    getMockProvider().generateOverrides.judge = () => {
      throw new Error("provider exploded");
    };
    const toolCtx = makeCtx(wrongContentDraft("judge-infra-error", GOAL));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(false);
    expect(data.judge).toEqual({ verdict: "skipped", reason: "judge_unavailable" });
  });

  test("blocks-since-commit caps after N regardless of fingerprint churn — edit between each block HOLDS (no auto-commit) at the cap and surfaces a terminal done-signal", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-breaker", GOAL));

    const editToFreshFailing = async (marker: string) => {
      await toolCtx.setDraft(
        normalizeDraftDocument({
          ...toolCtx.current(),
          workflow: {
            ...toolCtx.current().workflow,
            steps: [
              {
                id: "shape-email",
                kind: "transform",
                language: "javascript",
                expression: `return { html: "<p>Project: (${marker})</p>", projects: [{ name: "" }] };`,
              },
            ],
          },
        }),
      );
    };

    const first = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(first.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);

    await editToFreshFailing("v2");
    const second = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(second.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);

    await editToFreshFailing("v3");
    const third = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(third.ok).toBe(false);
    const thirdData = third.data as JudgeEnvelope;
    expect(thirdData.auto_committed).not.toBe(true);
    expect(thirdData.judge?.verdict).toBe("failed");
    expect(thirdData.judge_done?.committed_as_is).toBe(false);
    expect(thirdData.judge_done?.missing).toEqual(FAILED_VERDICT.missing);
    expect(thirdData.judge_done?.next_action).toContain("NOT committed");
    expect(thirdData.judge_done?.next_action).toContain("ask how to proceed");
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(1);
  });

  test("a model that ignores the EXIT and re-runs past the hold cap gets a forced escalation", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-escalate", GOAL));

    for (let i = 1; i <= JUDGE_BREAKER_MAX_BLOCKS; i++) {
      await dryRunWorkflowTool.execute(toolCtx, { input: null });
    }
    const firstHold = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect((firstHold.data as JudgeEnvelope).judge_done?.escalate).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(1);

    const escalated = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(escalated.ok).toBe(false);
    expect((escalated as { error_code?: string }).error_code).toBe("preview_judge_exhausted");
    const data = escalated.data as JudgeEnvelope;
    expect(data.judge_done?.escalate).toBe(true);
    expect(data.judge_done?.committed_as_is).toBe(false);
    expect(data.judge_done?.next_action).toContain("STOP");
    expect(data.judge_done?.next_action).toContain("ask the user to choose");
    expect(data.next_best_actions).toEqual(["save_workflow_draft"]);
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(2);
  });

  test("a commit resets the blocks-since-commit counter", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-commit-reset", GOAL), {
      permission_mode: "auto",
    });

    const block1 = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(block1.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);

    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "ok now",
      missing: [],
    });
    await toolCtx.setDraft(
      normalizeDraftDocument({
        ...toolCtx.current(),
        workflow: {
          ...toolCtx.current().workflow,
          steps: [
            {
              id: "shape-email",
              kind: "transform",
              language: "javascript",
              expression: `return { html: "<p>fixed</p>", projects: [{ name: "x" }] };`,
            },
          ],
        },
      }),
    );
    const committed = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(committed.ok).toBe(true);
    expect((committed.data as JudgeEnvelope).auto_committed).toBe(true);
    expect(toolCtx.current().state?.judge_breaker ?? null).toBeNull();
  });

  test("memoized verdict on an unchanged re-preview makes ZERO judge LLM calls", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-memo", GOAL));

    const first = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(first.ok).toBe(false);
    const callsAfterFirst = getMockProvider().calls.filter((c) => c.flow === "judge").length;
    expect(callsAfterFirst).toBe(1);

    const second = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(second.ok).toBe(false);
    const callsAfterSecond = getMockProvider().calls.filter((c) => c.flow === "judge").length;
    expect(callsAfterSecond).toBe(1);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);
    expect((second.data as JudgeEnvelope).judge?.verdict).toBe("failed");
  });

  test("a changed spec resets the breaker and re-judges an unchanged definition", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const base = wrongContentDraft("judge-spec-memo", GOAL);
    const spec = {
      goal: GOAL,
      inputs: [],
      outputs: [{ name: "html" }],
      delivery: null,
      conventions_applied: [],
      evidence: [],
      open_questions: [],
      origin: "chat" as const,
    };
    const toolCtx = makeCtx({ ...base, workflow: { ...base.workflow, spec } });

    await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge")).toHaveLength(1);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);

    await toolCtx.setDraft(
      withWorkflowDraft(toolCtx.current(), {
        ...toolCtx.current().workflow,
        spec: { ...spec, outputs: [{ name: "html" }, { name: "projects" }] },
      }),
    );
    expect(toolCtx.current().state?.judge_breaker ?? null).toBeNull();

    await dryRunWorkflowTool.execute(toolCtx, { input: null });
    const judgeCalls = getMockProvider().calls.filter((c) => c.flow === "judge");
    expect(judgeCalls).toHaveLength(2);
    expect(JSON.stringify(judgeCalls[1])).toContain("output `projects`");
  });

  test("a memoized verdict is not reused once the definition carries a spec", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const definition = WorkflowDefSchema.parse({
      name: "judge-spec-fingerprint",
      slug: "judge-spec-fingerprint",
      steps: [{ id: "shape", kind: "transform", language: "javascript", expression: "return 1;" }],
    });
    const gate = await runPreviewJudgeGate({
      tenant_id: ctx.tenant_id,
      conversation_id: uuid(),
      db: ctx.testDb.db,
      goal: GOAL,
      spec: {
        goal: GOAL,
        inputs: [],
        outputs: [{ name: "html" }],
        delivery: null,
        conventions_applied: [],
        evidence: [],
        open_questions: [],
        origin: "chat",
      },
      definition,
      steps: definition.steps as unknown as Array<Record<string, unknown>>,
      run_steps: [],
      prior_breaker: {
        blocks_since_commit: 0,
        last_verdict: {
          fingerprint: workflowDefinitionFingerprint(definition),
          verdict: "passes",
          reason: "memo",
          missing: [],
        },
      },
    });
    expect(gate.judgeOutcome?.verdict).toBe("failed");
    expect(getMockProvider().calls.filter((c) => c.flow === "judge")).toHaveLength(1);
  });

  test("explicit save still works after a failed verdict (judge gates AUTO-commit only)", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const slug = "judge-force-save";
    const { conversations, conversationElicitations } = await import("../../db/schema/index.ts");
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active", draft: {} })
      .returning();
    if (!conv) throw new Error("conversation insert failed");
    const toolCtx = {
      ...makeCtx(wrongContentDraft(slug, GOAL)),
      conversation_id: conv.id,
    };

    const blocked = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(blocked.ok).toBe(false);

    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id: conv.id,
      tool_name: "ask_user_confirm",
      summary: "commit anyway",
      input: { commit_intent: { kind: "save_workflow_draft" }, kind: "save_workflow_draft" },
      output: { confirmed: true },
      status: "resolved",
    });

    const saved = await saveWorkflowDraftTool.execute(toolCtx, { force_commit: true });
    expect(saved.ok).toBe(true);
    const savedData = saved.data as { slug?: string; version?: number };
    expect(savedData.slug).toBe(slug);
  });
});

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
