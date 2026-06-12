// Instruction-grounded preview judge (Fix C).
//
//   - wrong-content fixture (green preview, goal asks for project
//     names + droplet specs, output has empty names) → `failed` with
//     missing items, auto-commit BLOCKED, result carries the verdict,
//   - passing fixture → auto-commits with `judge.verdict: "passes"`,
//   - goal absent → `skipped`/`no_goal` and commits exactly as before,
//   - judge infrastructure error → `skipped`/`judge_unavailable` and
//     commits (the judge never blocks on an infra failure),
//   - circuit-breaker: two blocks per definition fingerprint, the
//     third identical preview degrades to advisory (commits); a
//     definition change resets the counter (blocks again),
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
import { normalizeDraftDocument } from "../authoring-state.ts";
import {
  buildJudgeDefinitionSummary,
  buildJudgeStepArtifacts,
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
  warnings?: Array<{ code: string; message: string }>;
  next_best_actions?: string[];
}

function makeCtx(initial: DraftDocument): ToolContext & { current: () => DraftDocument } {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
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
          language: "jsonata",
          expression: `{ "html": "<p>Project: ()</p>", "projects": [{"name": ""}] }`,
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
    // The breaker recorded the block, keyed on the def fingerprint.
    expect(toolCtx.current().state?.judge_breaker?.blocks).toBe(1);
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

  test("goal absent: judge skipped with no_goal, commit proceeds as today", async () => {
    // Override would FAIL the preview if the judge ran — proving the
    // skip really skipped the LLM call rather than passing by luck.
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-no-goal", null));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(true);
    expect(data.judge).toEqual({ verdict: "skipped", reason: "no_goal" });
    expect(getMockProvider().calls.filter((c) => c.flow === "judge").length).toBe(0);
  });

  test("judge infrastructure error: skipped with judge_unavailable, commit proceeds", async () => {
    getMockProvider().generateOverrides.judge = () => {
      throw new Error("provider exploded");
    };
    const toolCtx = makeCtx(wrongContentDraft("judge-infra-error", GOAL));

    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as JudgeEnvelope;
    expect(data.auto_committed).toBe(true);
    expect(data.judge).toEqual({ verdict: "skipped", reason: "judge_unavailable" });
  });

  test("circuit-breaker: two blocks per fingerprint, third identical preview is advisory; def change resets", async () => {
    getMockProvider().generateOverrides.judge = () => FAILED_VERDICT;
    const toolCtx = makeCtx(wrongContentDraft("judge-breaker", GOAL));

    const first = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(first.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks).toBe(1);

    const second = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(second.ok).toBe(false);
    expect(toolCtx.current().state?.judge_breaker?.blocks).toBe(2);

    // Third identical preview: verdict degrades to advisory — the
    // commit proceeds with the (still failed) verdict attached.
    const third = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(third.ok).toBe(true);
    const thirdData = third.data as JudgeEnvelope;
    expect(thirdData.auto_committed).toBe(true);
    expect(thirdData.judge?.verdict).toBe("failed");
    // Advisory did not increment the counter.
    expect(toolCtx.current().state?.judge_breaker?.blocks).toBe(2);

    // Definition change → new fingerprint → the judge may block again.
    const fingerprintBefore = toolCtx.current().state?.judge_breaker?.fingerprint;
    const mutated = normalizeDraftDocument({
      ...toolCtx.current(),
      workflow: {
        ...toolCtx.current().workflow,
        steps: [
          {
            id: "shape-email",
            kind: "transform",
            language: "jsonata",
            expression: `{ "html": "<p>Project: (still empty)</p>" }`,
          },
        ],
      },
    });
    await toolCtx.setDraft(mutated);
    const fourth = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(fourth.ok).toBe(false);
    const breaker = toolCtx.current().state?.judge_breaker;
    expect(breaker?.blocks).toBe(1);
    expect(breaker?.fingerprint).not.toBe(fingerprintBefore);
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

  test("judge_breaker survives the state normalize round-trip", () => {
    const normalized = normalizeDraftDocument({
      workflow: { name: "g", steps: [] },
      state: {
        mode: "workflow",
        stage: "workflow_draft_started",
        judge_breaker: { fingerprint: "abc123", blocks: 2 },
      },
    });
    expect(normalized.state?.judge_breaker).toEqual({ fingerprint: "abc123", blocks: 2 });
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
