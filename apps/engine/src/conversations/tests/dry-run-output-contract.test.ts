import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeToolCtx, type SeededToolContext } from "../../test-helpers/seed.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-output-contract");
});

afterAll(async () => {
  await ctx.cleanup();
});

const CONTRACT = {
  type: "object",
  properties: {
    total: { type: "number" },
    items: { type: "array" },
  },
  required: ["total", "items"],
};

function makeCtx(initial: DraftDocument): SeededToolContext {
  return makeToolCtx({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    ask_before_writing: true,
    actor_id: ctx.user_id,
    draft: initial,
  });
}

function draftWith(
  slug: string,
  expression: string,
  extra: Record<string, unknown> = {},
): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      steps: [{ id: "shape", kind: "transform", language: "javascript", expression }],
      output_schema: CONTRACT,
      ...extra,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

describe("dry_run_workflow · output contract", () => {
  test("mismatching final output: classification needs_repair, no auto-commit, field paths surfaced", async () => {
    const toolCtx = makeCtx(draftWith("contract-fails", "return { count: 1 };"));
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(false);
    const data = result.data as {
      classification?: string;
      auto_committed?: boolean;
      summary?: string;
      warnings?: Array<{ code: string; message: string; step_key: string | null }>;
      warnings_banner?: { codes: string[] };
    };
    expect(data.auto_committed).toBeUndefined();
    expect(data.classification).toBe("needs_repair");
    const warning = (data.warnings ?? []).find((w) => w.code === "output_contract_violation");
    expect(warning).toBeDefined();
    expect(warning?.step_key).toBe("$output");
    expect(warning?.message).toContain("$output/total");
    expect(warning?.message).toContain("$output/items");
    expect(data.warnings_banner?.codes).toContain("output_contract_violation");
  });

  test("contracted shape: same draft goes green and is ready to save", async () => {
    const toolCtx = makeCtx(draftWith("contract-passes", "return { total: 1, items: ['a'] };"));
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as { auto_committed?: boolean; save_required?: boolean };
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
  });

  test("output_transform shapes the payload the contract validates (execution parity)", async () => {
    const toolCtx = makeCtx(
      draftWith("contract-via-transform", "return { count: 3 };", {
        output_transform: "{ 'total': count, 'items': [] }",
      }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as { auto_committed?: boolean; save_required?: boolean };
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
  });
});
