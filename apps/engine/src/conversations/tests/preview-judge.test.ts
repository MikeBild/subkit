import { describe, expect, test } from "bun:test";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { WorkflowDefSchema } from "../../workflows/types.ts";
import { SPEC_GOAL_GUIDANCE } from "../authoring-spec.ts";
import { normalizeDraftDocument, withWorkflowDraft } from "../authoring-state/index.ts";
import { JUDGE_BREAKER_MAX_BLOCKS, workflowDefinitionFingerprint } from "../preview-judge.ts";
import { runPreviewJudgeGate } from "../preview-judge-gate.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import { saveWorkflowDraftTool } from "../tools/save-workflow-draft.ts";
import type { DraftDocument } from "../types.ts";
import {
  ctx,
  GOAL,
  type JudgeEnvelope,
  makeCtx,
  usePreviewJudgeSetup,
  uuid,
} from "./preview-judge-fixtures.ts";

usePreviewJudgeSetup();

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
