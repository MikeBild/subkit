import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xf1_a1_07);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-final-output");
});

afterAll(async () => {
  await ctx.cleanup();
});

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

const FINAL_OUTPUT_SENTINEL = "FINAL_OUTPUT_SENTINEL";

const STEP_STRUCTURED_OUTPUT = { rows: [{ a: 1 }, { a: 2 }] };

function sentinelDraft(slug: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "make_rows",
          kind: "transform",
          language: "javascript",
          expression: "return { rows: [{ a: 1 }, { a: 2 }] };",
        },
      ],
      output_transform: `"${FINAL_OUTPUT_SENTINEL}"`,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

function noTransformDraft(slug: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "make_rows",
          kind: "transform",
          language: "javascript",
          expression: "return { rows: [{ a: 1 }, { a: 2 }] };",
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

describe("dry_run_workflow · final_output contract", () => {
  test("final_output carries the post-output_transform value, NOT the last step's structured data", async () => {
    const toolCtx = makeCtx(sentinelDraft("final-output-sentinel"));
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as {
      final_output?: unknown;
      step_trace?: Array<{
        step_id: string;
        output_preview?: unknown;
      }>;
      auto_committed?: boolean;
      save_required?: boolean;
    };

    expect(data.final_output).toBe(FINAL_OUTPUT_SENTINEL);

    expect(data.final_output).not.toEqual(STEP_STRUCTURED_OUTPUT);

    const makeRowsTrace = (data.step_trace ?? []).find((s) => s.step_id === "make_rows");
    expect(makeRowsTrace).toBeDefined();
    expect(makeRowsTrace?.output_preview).toEqual(STEP_STRUCTURED_OUTPUT);

    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
  });

  test("latest_preview.preview is the post-output_transform final value, not the last step's output", async () => {
    const toolCtx = makeCtx(sentinelDraft("final-output-preview-field"));
    await dryRunWorkflowTool.execute(toolCtx, { input: null });

    const preview = toolCtx.current().latest_preview;
    expect(preview).toBeDefined();
    expect(preview?.ok).toBe(true);

    expect(preview?.preview).toBe(FINAL_OUTPUT_SENTINEL);
    expect(preview?.preview).not.toEqual(STEP_STRUCTURED_OUTPUT);
  });

  test("without an output_transform, final_output equals the last step output (fallback path)", async () => {
    const toolCtx = makeCtx(noTransformDraft("final-output-no-transform"));
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });

    expect(result.ok).toBe(true);
    const data = result.data as {
      final_output?: unknown;
      step_trace?: Array<{ step_id: string; output_preview?: unknown }>;
    };

    expect(data.final_output).toEqual(STEP_STRUCTURED_OUTPUT);

    const trace = (data.step_trace ?? []).find((s) => s.step_id === "make_rows");
    expect(trace).toBeDefined();
    expect(trace?.output_preview).toEqual(STEP_STRUCTURED_OUTPUT);

    const preview = toolCtx.current().latest_preview;
    expect(preview?.preview).toEqual(STEP_STRUCTURED_OUTPUT);
  });
});
