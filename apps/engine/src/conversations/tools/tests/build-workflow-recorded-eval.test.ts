// Fix 9 integration: `build_workflow` / `propose_step` accept the
// draft and return the recorded-evaluation findings in the SAME result
// envelope — the loop/transform gates are outcomes, not preconditions
// — and the whole pass fires ZERO live HTTP (no egress). Regression
// for the session-784c1b02 thrash (102 dry_run_workflow calls, 16×
// `loop_authoring_requires_inspect`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { setDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { RecordedEvalReport } from "../../recorded-eval.ts";
import type { DraftDocument } from "../../types.ts";
import { buildWorkflowTool } from "../build-workflow.ts";
import type { ToolContext } from "../index.ts";
import { proposeStepTool } from "../propose-step.ts";

let ctx: TestDb;
let tenant_id: string;
const nextUuid = createDeterministicUuidFactory(784);

// Egress tripwire: any DRIVER egress during the tools under test is a
// live HTTP call the recorded-eval contract forbids. Installed through
// the driver-fetch seam (drivers no longer read globalThis.fetch, so a
// globalThis stub would miss real egress AND leak into sibling files).
let fetchCalls = 0;

beforeAll(async () => {
  ctx = await createTestDb("build_workflow_recorded_eval");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-receval", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  setDriverFetchForTests(null);
  await ctx.cleanup();
});

beforeEach(() => {
  fetchCalls = 0;
  setDriverFetchForTests(((..._args: unknown[]) => {
    fetchCalls += 1;
    throw new Error("live HTTP is forbidden during build_workflow / propose_step");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  setDriverFetchForTests(null);
});

function makeCtx(): ToolContext & { _draft: { value: DraftDocument | null } } {
  const ref: { value: DraftDocument | null } = { value: null };
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

/** Leave the initial authoring stage: `propose_step` is a repair-stage
 *  tool now (Fix A stage gate) and refuses while the draft has no
 *  recorded preview / findings. These tests exercise the recorded-eval
 *  envelope on the repair flow, so seed minimal preview evidence. */
function seedStageEvidence(toolCtx: ReturnType<typeof makeCtx>): void {
  toolCtx._draft.value = {
    ...createEmptyDraftDocument(),
    latest_preview: { ok: false, step_id: null, summary: "stage evidence", step_traces: [] },
  };
}

describe("build_workflow — recorded_eval envelope (Fix 9)", () => {
  test("loop without recorded evidence: draft ACCEPTED, gate verdict + missing evidence in envelope, zero egress", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "Loop without evidence",
      slug: "loop-no-evidence",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
        { id: "iter", kind: "loop", over: "$scope.fetch.data", body: ["b"] },
        { id: "b", kind: "transform", language: "jsonata", expression: "$item" },
      ],
      environment: "dev",
    });

    // The old behavior bounced this call with
    // `loop_authoring_requires_inspect`. Post-fix the draft lands…
    expect(result.ok).toBe(true);
    expect(toolCtx._draft.value?.workflow.slug).toBe("loop-no-evidence");

    // …and the gate verdict travels in the SAME envelope, with the
    // exact missing evidence and the exact next action.
    const data = result.data as {
      recorded_eval: RecordedEvalReport;
      next_step: string;
    };
    expect(data.recorded_eval.ok).toBe(false);
    expect(data.recorded_eval.gates.loop.ok).toBe(false);
    expect(data.recorded_eval.missing_evidence.map((m) => m.step_id)).toContain("fetch");
    expect(data.recorded_eval.missing_evidence[0]?.next_action).toBe("dry_run_workflow");
    expect(data.recorded_eval.next_actions).toContain("dry_run_workflow");
    expect(data.next_step).toBe("dry_run_workflow");

    // CRITICAL: no live HTTP fired implicitly.
    expect(fetchCalls).toBe(0);
  });

  test("clean build (no scope refs) reports recorded_eval.ok and keeps save as the next step", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "Plain wait",
      slug: "plain-wait",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { recorded_eval: RecordedEvalReport; next_step: string };
    expect(data.recorded_eval.ok).toBe(true);
    expect(data.next_step).toBe("save_workflow_draft");
    expect(fetchCalls).toBe(0);
  });
});

describe("propose_step — recorded_eval envelope (Fix 9)", () => {
  test("branch with a bad JSONata `when` is accepted with a caret compile error in the envelope", async () => {
    const toolCtx = makeCtx();
    seedStageEvidence(toolCtx);
    const first = await proposeStepTool.execute(toolCtx, {
      step: { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
    });
    expect(first.ok).toBe(true);
    const result = await proposeStepTool.execute(toolCtx, {
      step: {
        id: "gate",
        kind: "branch",
        when: "items[",
        then_steps: ["fetch"],
      },
    });
    expect(result.ok).toBe(true);
    const data = result.data as { recorded_eval: RecordedEvalReport };
    const finding = data.recorded_eval.expressions.find((f) => f.site === "steps.gate.when");
    expect(finding?.status).toBe("compile_error");
    expect(finding?.message).toContain("█");
    expect(data.recorded_eval.ok).toBe(false);
    expect(data.recorded_eval.next_actions).toContain("update_param");
    expect(fetchCalls).toBe(0);
  });

  test("transform reading an un-previewed sibling is accepted with the transform gate verdict in the envelope", async () => {
    const toolCtx = makeCtx();
    seedStageEvidence(toolCtx);
    await proposeStepTool.execute(toolCtx, {
      step: { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
    });
    const result = await proposeStepTool.execute(toolCtx, {
      step: {
        id: "shape",
        kind: "transform",
        language: "jsonata",
        expression: "$scope.fetch.data.items",
      },
    });
    // Old behavior: bounced with `transform_authoring_requires_inspect`.
    expect(result.ok).toBe(true);
    const data = result.data as { recorded_eval: RecordedEvalReport };
    expect(data.recorded_eval.gates.transform.ok).toBe(false);
    expect(
      data.recorded_eval.gates.transform.blocks.some((b) => b.referenced_step_id === "fetch"),
    ).toBe(true);
    expect(data.recorded_eval.missing_evidence.map((m) => m.step_id)).toContain("fetch");
    expect(fetchCalls).toBe(0);
  });
});
