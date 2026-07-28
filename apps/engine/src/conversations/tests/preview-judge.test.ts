// Instruction-grounded preview judge (Fix C).
//
//   - wrong-content fixture (green preview, goal asks for project
//     names + droplet specs, output has empty names) → `failed` with
//     missing items, auto-commit BLOCKED, result carries the verdict,
//   - passing fixture → auto-commits with `judge.verdict: "passes"`,
//   - goal absent → `skipped`/`no_goal`, green preview is NOT auto-committed
//     (returns save_required so the user/model persists deliberately),
//   - judge infrastructure error → `skipped`/`judge_unavailable`; the judge
//     still never BLOCKS (the envelope stays ok), but with a human present the
//     auto-commit is withheld: an unjudged preview is persisted deliberately,
//     not silently. Unattended turns still commit, since the deferral would
//     dead-end on a prompt nobody can answer,
//   - circuit-breaker: after the block cap the edit LOOP is broken but the
//     preview is HELD (never auto-committed) and a terminal done-signal is
//     surfaced so the model stops re-running and asks the user; the counter
//     holds at the cap (only a real commit resets it),
//   - explicit save (`save_workflow_draft`, incl. force_commit) still
//     works after a failed verdict — the judge only gates AUTO-commit,
//   - the goal stash survives the draft normalize round-trip for both
//     entry points (author_workflow pipeline-emit shape + build_workflow
//     carry-over).
//
// LLM provider is the in-process mock (`LLM_PROVIDER=mock` via the
// conversation test ctx + `generateOverrides.judge`) — no network,
// deterministic.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
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
  judgePreview,
  workflowDefinitionFingerprint,
} from "../preview-judge.ts";
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
  judge?: { verdict: string; reason: string; missing?: string[] };
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

/** A green-previewable draft: one pure transform step, empty project
 *  names — the "Project: ()" incident shape. `goal` rides the draft
 *  exactly as the authoring pipeline's EMIT stage stashes it. */
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

    // The blocked preview joins the requires_repair path on the draft.
    expect(toolCtx.current().latest_preview?.requires_repair).toBe(true);
    // The breaker recorded the block as blocks-since-commit (P3).
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);
  });

  test("passing fixture: auto-commits and the result carries the passes verdict", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Output contains project names and droplet specs.",
      missing: [],
    });
    const toolCtx = makeCtx(wrongContentDraft("judge-passes", GOAL));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(true);
    expect(data.judge?.verdict).toBe("passes");
    expect(toolCtx.current().state?.judge_breaker ?? null).toBeNull();
  });

  test("passing fixture re-run against the same draft is already_persisted, not a second commit", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "passes",
      reason: "Output contains project names and droplet specs.",
      missing: [],
    });
    const toolCtx = makeCtx(wrongContentDraft("judge-passes-idempotent", GOAL));

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
    // Override would FAIL the preview if the judge ran — proving the
    // skip really skipped the LLM call rather than passing by luck.
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-no-goal", null));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    // a green dry-run with no stashed goal is no longer auto-persisted —
    // the judge is skipped, so the engine cannot vouch for the result. The
    // preview is still `ok` and returns the save_workflow_draft next-action so
    // the model/user commits once, deliberately (no per-iteration version churn).
    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(false);
    expect((data as { save_required?: boolean }).save_required).toBe(true);
    expect((data as { next_best_actions?: string[] }).next_best_actions).toEqual([
      "save_workflow_draft",
    ]);
    expect(data.judge).toEqual({ verdict: "skipped", reason: "no_goal" });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(0);
  });

  test("UNATTENDED (backgrounded MCP surface): green + no-goal preview AUTO-COMMITS instead of deferring to save", async () => {
    // A backgrounded MCP turn cannot surface a `save_workflow_draft` →
    // ask_user_confirm follow-up (no live session), so the attended
    // greenPendingSave deferral would dead-end. The no-goal green preview must
    // auto-commit. The judge would FAIL if it ran — proving the skip is a
    // genuine no_goal skip, not a lucky pass.
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-unattended-mcp", null), {
      surface: "mcp",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & {
      workflow_id?: string;
      save_required?: boolean;
    };
    // Committed: target_workflow_id present, auto_committed true, NO save gate.
    expect(data.auto_committed).toBe(true);
    expect(typeof data.workflow_id).toBe("string");
    expect(result.committed_workflow_id).toBe(data.workflow_id);
    expect(data.save_required).toBeUndefined();
    // Audit metadata stays honest: the judge was skipped (no goal), not passed.
    expect(data.judge).toEqual({ verdict: "skipped", reason: "no_goal" });
    // The judge LLM never ran — no_goal short-circuits before the call.
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(0);
  });

  test('UNATTENDED (permission_mode "auto"): green + no-goal preview AUTO-COMMITS', async () => {
    // "auto" is the explicit "don't ask" signal on any surface — a no-goal
    // green preview auto-commits rather than returning save_required.
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-unattended-auto", null), {
      permission_mode: "auto",
    });

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope & { save_required?: boolean };
    expect(data.auto_committed).toBe(true);
    expect(data.save_required).toBeUndefined();
    expect(data.judge).toEqual({ verdict: "skipped", reason: "no_goal" });
  });

  test("UNATTENDED does NOT weaken the quality gate: a failed verdict STILL blocks the auto-commit", async () => {
    // MUST-KEEP: unattended relaxes only the no-goal SAVE deferral. A goal is
    // present and the judge FAILS → the preview must NOT auto-commit even on a
    // backgrounded MCP turn (the load-bearing "never mint a goal-mismatched
    // workflow" guard).
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
    // The default attended sk-cli path must not regress: no goal → judge
    // skipped → save_required, no auto-commit.
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
    expect(data.judge).toEqual({ verdict: "skipped", reason: "no_goal" });
  });

  test("judge infrastructure error, human present: skipped with judge_unavailable and NOT auto-committed", async () => {
    // The judge fails open — it never turns an infra outage into a blocked
    // preview, and the envelope stays `ok`. What it must not do is let an
    // UNJUDGED preview mint a workflow version while a human is sitting there:
    // keying the deferral on `no_goal` alone meant a provider outage silently
    // auto-committed work nobody vouched for. The green result plus an explicit
    // save is one keystroke; the silent commit is unrecoverable trust.
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

    // Edit the draft to a fresh, still-failing transform between every
    // preview so the definition fingerprint changes each time — the OLD
    // per-fingerprint breaker would reset to 0 and never cap. The P3
    // blocks-since-commit breaker is monotonic across edits.
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
    // Counter advanced even though the fingerprint changed.
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);

    await editToFreshFailing("v3");
    // At the cap now: the breaker breaks the edit LOOP but NOT the quality
    // gate — the still-failing preview is HELD (not committed) and carries a
    // terminal done-signal with the missing items so the model stops re-running
    // dry_run_workflow and asks the user instead.
    const third = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(third.ok).toBe(false);
    const thirdData = third.data as JudgeEnvelope;
    expect(thirdData.auto_committed).not.toBe(true);
    expect(thirdData.judge?.verdict).toBe("failed");
    expect(thirdData.judge_done?.committed_as_is).toBe(false);
    expect(thirdData.judge_done?.missing).toEqual(FAILED_VERDICT.missing);
    expect(thirdData.judge_done?.next_action).toContain("NOT committed");
    expect(thirdData.judge_done?.next_action).toContain("ask how to proceed");
    // No commit happened, so the breaker counter is NOT reset — it holds at
    // the cap so a model that ignores the EXIT keeps hitting the hold branch
    // rather than slipping an unsatisfied commit through.
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);
    // First hold at the cap is recorded.
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(1);
  });

  test("a model that ignores the EXIT and re-runs past the hold cap gets a forced escalation", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-escalate", GOAL));

    // Drive blocks 1..MAX (each ok:false), then the first hold at the cap.
    for (let i = 1; i <= JUDGE_BREAKER_MAX_BLOCKS; i++) {
      await dryRunWorkflowTool.execute(toolCtx, { input: null });
    }
    const firstHold = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect((firstHold.data as JudgeEnvelope).judge_done?.escalate).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(1);

    // The model ignores the EXIT and re-runs — at ESCALATE_AFTER holds the gate
    // forces an operator-choice escalation instead of another silent hold.
    const escalated = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(escalated.ok).toBe(false);
    expect((escalated as { error_code?: string }).error_code).toBe("preview_judge_exhausted");
    const data = escalated.data as JudgeEnvelope;
    expect(data.judge_done?.escalate).toBe(true);
    expect(data.judge_done?.committed_as_is).toBe(false);
    expect(data.judge_done?.next_action).toContain("STOP");
    expect(data.judge_done?.next_action).toContain("ask the user to choose");
    // Only the commit-as-is tool action is offered — editing/re-running is gone.
    expect(data.next_best_actions).toEqual(["save_workflow_draft"]);
    expect(toolCtx.current().state?.judge_breaker?.holds_at_cap).toBe(2);
  });

  test("a commit resets the blocks-since-commit counter", async () => {
    // First a passing preview commits (counter is 0 → stays 0/clears).
    // Then re-block twice and confirm the counter restarts from 1.
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-commit-reset", GOAL));

    const block1 = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(block1.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(1);

    // Force a clean commit by switching the verdict to passes + editing.
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
    // Commit cleared the breaker.
    expect(toolCtx.current().state?.judge_breaker ?? null).toBeNull();
  });

  test("memoized verdict on an unchanged re-preview makes ZERO judge LLM calls", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-memo", GOAL));

    const first = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(first.ok).toBe(false);
    const callsAfterFirst = getMockProvider().calls.filter((c) => c.flow === "judge").length;
    expect(callsAfterFirst).toBe(1);

    // Re-preview the UNCHANGED draft (same fingerprint). The verdict is
    // reused from the memo — no second judge LLM call fires.
    const second = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(second.ok).toBe(false);
    const callsAfterSecond = getMockProvider().calls.filter((c) => c.flow === "judge").length;
    expect(callsAfterSecond).toBe(1);
    // The block still counted (blocks-since-commit is monotonic).
    expect(toolCtx.current().state?.judge_breaker?.blocks_since_commit).toBe(2);
    // The reused verdict still rode the result.
    expect((second.data as JudgeEnvelope).judge?.verdict).toBe("failed");
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

    // Operator explicitly confirms the save despite the verdict.
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
    // A draft accumulated 2 blocks against goal A (now at advisory).
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
    // Re-author under a DIFFERENT goal → breaker must reset, so the
    // first judge on goal B can still BLOCK (not silently advisory-commit).
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

  test("a legacy { fingerprint, blocks } judge_breaker seeds blocks_since_commit", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "g", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { fingerprint: "legacy", blocks: 2 },
      },
    });
    expect(normalized.state?.judge_breaker?.blocks_since_commit).toBe(2);
    expect(normalized.state?.judge_breaker?.last_verdict ?? null).toBeNull();
  });
});

describe("preview judge · filter-violation downgrade wiring", () => {
  // The goal EXPLICITLY excludes a value ("(not connected)"); if that value
  // shows up in the rendered output the LLM "passes" must be downgraded to
  // "partial". Mock provider returns "passes"; the deterministic
  // findFilterViolations check decides. No real LLM key needed.
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
  // These tests call judgePreview() directly to isolate the format-mismatch
  // guard from the dry_run_workflow tool machinery. The mock provider's
  // generateOverrides.judge controls what the LLM "returns", and the
  // deterministic outputMatchesFormat check then decides whether to
  // downgrade a "passes" verdict.

  const MARKDOWN_GOAL = "return a markdown table that ranks the top cities by population";

  // A JSON-array output_preview — structurally NOT a markdown table.
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

  // A proper markdown table output_preview.
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
    // missing must contain at least the two markdown-table structural gaps.
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
      // The render STEP produced a proper markdown table…
      step_artifacts: markdownTableArtifacts,
      // …but the workflow's FINAL output (post output_transform) is a JSON
      // array — exactly the real defect this fix targets.
      final_output: [
        { rank: 1, city: "Berlin", max_temp_c: 25 },
        { rank: 2, city: "Hamburg", max_temp_c: 23 },
      ],
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    // Must downgrade: the caller receives structured data, not a markdown table.
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
      // Steps are structured…
      step_artifacts: jsonArrayArtifacts,
      // …but the FINAL output is a proper markdown table string.
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
      // No format keyword — "email me the droplet specs" names no format.
      goal: "email me the droplet specs for each project",
      definition_summary: "- shape (transform): collect specs",
      // JSON-array output — would fail a markdown-table check if the guard fired.
      step_artifacts: jsonArrayArtifacts,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
    });

    // Guard must NOT fire: no format was named, so "passes" is untouched.
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

    // Already "partial" — format guard does not run a second time.
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

describe("preview judge · bounded-field coercion + retry (fail-open fix)", () => {
  // Root cause: `invoke` validates the model output against the JSON-Schema-7
  // projection of JudgeVerdictSchema, which DROPS zod's `.max()` length
  // bounds. A verdict with an over-long `reason` / oversized `missing`
  // satisfied the provider but FAILED the old strict re-parse → it was
  // discarded as `judge_unavailable` and the commit proceeded UNGATED. The
  // fix clamps the bounded fields so a valid verdict is never skipped on a
  // length overflow.
  const GOAL_PLAIN = "email me the droplet specs for each project";

  test("over-bounds verdict is CLAMPED, not skipped (no fail-open)", async () => {
    getMockProvider().generateOverrides.judge = () => ({
      verdict: "failed",
      reason: "x".repeat(2000), // > 800-char bound
      missing: Array.from({ length: 30 }, (_, i) => `${"m".repeat(500)}-${i}`), // > 12 entries, each > 300
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

    // The verdict survives (was a real "failed" — must not become a skip).
    expect(outcome.verdict).toBe("failed");
    if (outcome.verdict === "failed") {
      // reason clamped to the 800-char bound, missing clamped to ≤12 entries
      // each ≤300 chars — the bounds the JSON schema dropped.
      expect(outcome.reason.length).toBeLessThanOrEqual(800);
      expect(outcome.missing.length).toBeLessThanOrEqual(12);
      for (const m of outcome.missing) expect(m.length).toBeLessThanOrEqual(300);
    }
    // Exactly one judge call — a coercible verdict does NOT trigger the retry.
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(1);
  });

  test("a malformed object recovers on the ONE bounded retry", async () => {
    let n = 0;
    getMockProvider().generateOverrides.judge = () =>
      n++ === 0
        ? // first response carries no valid `verdict` enum
          ({ nonsense: true } as never)
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
    // Retried exactly once.
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

    // Fail-OPEN — a persistently un-judgeable preview skips (commit proceeds),
    // it does NOT block (that would deadlock authoring).
    expect(outcome).toEqual({ verdict: "skipped", reason: "judge_unavailable" });
    // One initial call + one bounded retry.
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
    // Many small keys: structurally truncation-resistant, so each
    // artifact lands near the ~1.5KB per-step cap and the 6KB total
    // budget genuinely bites on the later request steps.
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
    // The transform is always in; the trailing requests get dropped
    // once the total budget is exhausted.
    expect(artifacts.some((a) => a.step_id === "shape")).toBe(true);
    expect(artifacts.length).toBeLessThan(5);
    // Definition order restored (shape last).
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
