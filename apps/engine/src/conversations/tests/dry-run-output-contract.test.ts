// dry_run_workflow × output_schema (Fix 11) — the preview is where the
// output contract BLOCKS. A draft whose final output violates its
// declared `output_schema`:
//   - is classified `needs_repair` (preview not green),
//   - does NOT auto-commit,
//   - carries the field-level `$output/...` paths in the warning
//     entries / banner.
// Once the draft produces the contracted shape the same dry-run goes
// green and auto-commits. `output_transform` travels with the dry-run
// definition so the contract validates the TRUE final payload —
// execution parity with live runs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x0c0_117ac1);

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

    // Blocking: the preview is NOT green and the draft did not commit.
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
    // Field-level paths name exactly what the author must produce.
    expect(warning?.message).toContain("$output/total");
    expect(warning?.message).toContain("$output/items");
    expect(data.warnings_banner?.codes).toContain("output_contract_violation");
  });

  test("contracted shape: same draft goes green and auto-commits", async () => {
    const toolCtx = makeCtx(draftWith("contract-passes", "return { total: 1, items: ['a'] };"));
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as { auto_committed?: boolean };
    expect(data.auto_committed).toBe(true);
  });

  test("output_transform shapes the payload the contract validates (execution parity)", async () => {
    // The step output alone violates the contract; the workflow-level
    // output_transform produces the contracted shape. The dry-run must
    // validate the POST-transform payload — i.e. pass.
    const toolCtx = makeCtx(
      draftWith("contract-via-transform", "return { count: 3 };", {
        output_transform: "{ 'total': count, 'items': [] }",
      }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as { auto_committed?: boolean };
    expect(data.auto_committed).toBe(true);
  });
});
