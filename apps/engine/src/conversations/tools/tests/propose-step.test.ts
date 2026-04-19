// Unit tests for the propose_step tool. Cover both happy path and the
// enriched failure envelope the model relies on for self-correction.

import { describe, expect, it } from "bun:test";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext, ToolResult } from "../index.ts";
import { proposeStepTool } from "../propose-step.ts";

function mkCtx(initial?: Partial<DraftDocument>): {
  ctx: ToolContext;
  getDraft: () => DraftDocument;
} {
  let draft: DraftDocument = {
    workflow: {
      name: "test-workflow",
      steps: [],
    },
    ...(initial ?? {}),
  };
  const ctx = {
    getDraft: () => draft,
    setDraft: async (next: DraftDocument) => {
      draft = next;
    },
    // Unused fields — the propose-step tool only touches getDraft/setDraft.
    db: {} as ToolContext["db"],
    tenant_id: "t-test",
    conversation_id: "c-test",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
  } satisfies ToolContext;
  return { ctx, getDraft: () => draft };
}

async function run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
  return proposeStepTool.execute(ctx, args);
}

describe("propose_step", () => {
  it("snapshots a valid request step", async () => {
    const { ctx, getDraft } = mkCtx();
    const result = await run(
      {
        step: { id: "fetch", kind: "request", method: "GET", url: "https://example.com/x" },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(getDraft().workflow.steps).toHaveLength(1);
    expect(getDraft().workflow.steps[0]).toMatchObject({ id: "fetch", kind: "request" });
  });

  it("replaces by id when called twice with the same step id", async () => {
    const { ctx, getDraft } = mkCtx();
    await run({ step: { id: "s", kind: "wait", duration_ms: 1000 } }, ctx);
    await run({ step: { id: "s", kind: "wait", duration_ms: 5000 } }, ctx);
    expect(getDraft().workflow.steps).toHaveLength(1);
    expect((getDraft().workflow.steps[0] as { duration_ms: number }).duration_ms).toBe(5000);
  });

  it("flags `type` instead of `kind` with used_wrong_key=true", async () => {
    const { ctx } = mkCtx();
    const result = await run(
      { step: { id: "trigger", type: "trigger.manual", name: "start" } },
      ctx,
    );
    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.used_wrong_key).toBe(true);
    expect(data.attempted_kind).toBe("trigger.manual");
    expect(data.valid_kinds).toEqual([
      "request",
      "transform",
      "call",
      "wait",
      "branch",
      "parallel",
      "loop",
      "tool",
    ]);
    expect(typeof data.message).toBe("string");
    expect(data.message).toContain("`kind`");
  });

  it("returns valid_kinds (no required_fields) for a hallucinated kind", async () => {
    const { ctx } = mkCtx();
    const result = await run({ step: { id: "approve", kind: "flow.approval" } }, ctx);
    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.attempted_kind).toBe("flow.approval");
    expect(data.used_wrong_key).toBe(false);
    expect(Array.isArray(data.valid_kinds)).toBe(true);
    expect(data.required_fields_for_kind).toBeUndefined();
    expect(data.example_for_kind).toBeDefined();
    expect(data.message).toContain("not a valid kind");
  });

  it("returns required_fields_for_kind for a valid kind missing fields", async () => {
    const { ctx } = mkCtx();
    const result = await run({ step: { id: "branch1", kind: "branch" } }, ctx);
    expect(result.ok).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.attempted_kind).toBe("branch");
    expect(data.required_fields_for_kind).toEqual(["id", "kind", "when", "then_steps"]);
    expect(data.example_for_kind).toMatchObject({ kind: "branch" });
  });

  it("does not snapshot the draft when validation fails", async () => {
    const { ctx, getDraft } = mkCtx();
    await run({ step: { id: "bad", type: "trigger.manual" } }, ctx);
    expect(getDraft().workflow.steps).toHaveLength(0);
  });
});
