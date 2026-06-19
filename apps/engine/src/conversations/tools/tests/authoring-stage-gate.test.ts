// Deterministic stage-gating of the micro-authoring tools (Fix A).
//
//   - `propose_step` / `update_param` refuse with the typed
//     `authoring_stage_violation` ONLY while the draft is in its
//     initial stage (no recorded preview AND no recorded-eval/judge
//     findings),
//   - the moment a preview exists (even a FAILED one), both unlock,
//   - judge-breaker state unlocks,
//   - recorded-eval findings persisted on a one-shot build's tool
//     output unlock — the model can apply a proposed repair before the
//     first preview,
//   - DEADLOCK IMPOSSIBILITY: every action the refusal recommends is
//     itself ungated (GATED_TOOLS ∩ GATE_RECOMMENDED_ACTIONS = ∅), and
//     the recommended actions are exactly the refusal's
//     `next_best_actions`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, conversationToolCalls, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import {
  draftHasStageEvidence,
  evaluateAuthoringStageGate,
  GATE_RECOMMENDED_ACTIONS,
  GATED_TOOLS,
} from "../authoring-stage-gate.ts";
import type { ToolContext } from "../index.ts";
import { proposeStepTool } from "../propose-step.ts";
import { updateParamTool } from "../update-param.ts";

let ctx: TestDb;
let tenant_id: string;
const nextUuid = createDeterministicUuidFactory(0x57a_6e);

beforeAll(async () => {
  ctx = await createTestDb("authoring_stage_gate");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-stage-gate", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(
  initial?: DraftDocument,
): ToolContext & { _draft: { value: DraftDocument | null } } {
  const ref: { value: DraftDocument | null } = { value: initial ?? null };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ref.value ?? createEmptyDraftDocument(),
    setDraft: async (d) => {
      ref.value = d;
    },
    _draft: ref,
  };
}

function withPreviewEvidence(ok: boolean): DraftDocument {
  return {
    ...createEmptyDraftDocument(),
    latest_preview: { ok, step_id: null, summary: "preview recorded", step_traces: [] },
  };
}

const STEP = { id: "fetch", kind: "request", method: "GET", url: "https://example.com/x" };

describe("initial-stage refusal", () => {
  test("propose_step refuses with authoring_stage_violation on a fresh draft", async () => {
    const toolCtx = makeCtx();
    const result = await proposeStepTool.execute(toolCtx, { step: STEP });
    expect(result.ok).toBe(false);
    const data = (result as { data?: Record<string, unknown> }).data as Record<string, unknown>;
    expect(data.error_code).toBe("authoring_stage_violation");
    expect(data.next_best_actions).toEqual([...GATE_RECOMMENDED_ACTIONS]);
    // The draft was NOT mutated by the refused call.
    expect(toolCtx._draft.value).toBeNull();
  });

  test("update_param refuses with authoring_stage_violation on a fresh draft", async () => {
    const toolCtx = makeCtx();
    const result = await updateParamTool.execute(toolCtx, {
      step_id: "fetch",
      param: "method",
      value: "POST",
    });
    expect(result.ok).toBe(false);
    const data = (result as { data?: Record<string, unknown> }).data as Record<string, unknown>;
    expect(data.error_code).toBe("authoring_stage_violation");
    expect(data.next_best_actions).toEqual([...GATE_RECOMMENDED_ACTIONS]);
  });
});

describe("unlock conditions", () => {
  test("a recorded preview unlocks propose_step — even a FAILED preview counts", async () => {
    const toolCtx = makeCtx(withPreviewEvidence(false));
    const result = await proposeStepTool.execute(toolCtx, { step: STEP });
    expect(result.ok).toBe(true);
  });

  test("a recorded preview unlocks update_param", async () => {
    const base = withPreviewEvidence(true);
    base.workflow = { name: "wf", slug: "wf", steps: [{ ...STEP }] };
    const toolCtx = makeCtx(base);
    const result = await updateParamTool.execute(toolCtx, {
      step_id: "fetch",
      param: "method",
      value: "POST",
    });
    expect(result.ok).toBe(true);
  });

  test("judge-breaker state unlocks (judge findings exist for this draft)", async () => {
    const draft = createEmptyDraftDocument();
    draft.state = {
      ...(draft.state ?? {
        mode: "workflow",
        stage: "idle",
        connector_mutation_seq: 0,
        workflow_mutation_seq: 0,
        checkpoints: {},
        persisted_resources: [],
        latest_execution: null,
        latest_diagnosis: null,
      }),
      judge_breaker: { blocks_since_commit: 1 },
    };
    expect(draftHasStageEvidence(draft)).toBe(true);
    const toolCtx = makeCtx(draft);
    const result = await proposeStepTool.execute(toolCtx, { step: STEP });
    expect(result.ok).toBe(true);
  });

  test("recorded-eval findings on a persisted one-shot build output unlock before any preview", async () => {
    const toolCtx = makeCtx();
    // A conversation whose author_workflow call already surfaced
    // findings — persisted exactly the way the loop stores outputs.
    await ctx.db.insert(conversations).values({
      id: toolCtx.conversation_id,
      tenant_id,
      status: "active",
    });
    await ctx.db.insert(conversationToolCalls).values({
      tenant_id,
      conversation_id: toolCtx.conversation_id,
      tool: "author_workflow",
      input: { goal: "g" },
      output: { ok: true, data: { recorded_eval: { ok: false, summary: "findings" } } },
    });
    const result = await proposeStepTool.execute(toolCtx, { step: STEP });
    expect(result.ok).toBe(true);
  });

  test("a green recorded_eval on the build output does NOT unlock — the recommended action is the preview", async () => {
    const toolCtx = makeCtx();
    await ctx.db.insert(conversations).values({
      id: toolCtx.conversation_id,
      tenant_id,
      status: "active",
    });
    await ctx.db.insert(conversationToolCalls).values({
      tenant_id,
      conversation_id: toolCtx.conversation_id,
      tool: "author_workflow",
      input: { goal: "g" },
      output: { ok: true, data: { recorded_eval: { ok: true, summary: "clean" } } },
    });
    const result = await proposeStepTool.execute(toolCtx, { step: STEP });
    expect(result.ok).toBe(false);
  });
});

describe("deadlock impossibility", () => {
  test("every recommended action of the gate is itself ungated", () => {
    for (const action of GATE_RECOMMENDED_ACTIONS) {
      expect(GATED_TOOLS).not.toContain(action);
    }
  });

  test("the refusal recommends exactly the ungated unlock path", async () => {
    for (const tool of GATED_TOOLS) {
      const refusal = await evaluateAuthoringStageGate(makeCtx(), tool);
      expect(refusal).not.toBeNull();
      const data = (refusal as { data?: Record<string, unknown> })?.data as Record<string, unknown>;
      expect(data.error_code).toBe("authoring_stage_violation");
      const recommended = data.next_best_actions as string[];
      expect(recommended).toEqual([...GATE_RECOMMENDED_ACTIONS]);
      // Following any recommended action produces unlock evidence:
      // dry_run records latest_preview; author/build/edit attach
      // recorded_eval findings — both unlock branches are covered by
      // the tests above. Here we pin that no recommended action can
      // itself be refused by this gate.
      for (const action of recommended) {
        expect(await evaluateAuthoringStageGate(makeCtx(), action)).toBeNull();
      }
    }
  });
});

describe("tool-description pins (repair-stage framing)", () => {
  test("propose_step and update_param describe themselves as repair-stage tools", () => {
    expect(proposeStepTool.description).toContain("REPAIR-STAGE");
    expect(proposeStepTool.description).toContain("author_workflow");
    expect(proposeStepTool.description).toContain("authoring_stage_violation");
    expect(updateParamTool.description).toContain("REPAIR-STAGE");
    expect(updateParamTool.description).toContain("author_workflow");
    expect(updateParamTool.description).toContain("authoring_stage_violation");
  });
});
