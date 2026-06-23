// dry_run_workflow × final_output — the dry-run response must expose the
// workflow's RESOLVED final output (post output_transform) in the
// `final_output` field, and `latest_preview.preview` must carry that same
// resolved value — NOT the last step's intermediate structured output.
//
// Why: when an output_transform exists, the last step's output_preview and
// the workflow's public payload DIFFER. A model/benchmark reading
// `latest_preview.preview` or `data.final_output` from a dry-run result must
// see the value the CALLER receives after the transform runs, not the
// intermediate shape that the transform discards. This test locks that
// contract so a future refactor cannot silently regress it back to the last
// step's output.

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

// A fixed sentinel string the JSONata output_transform produces. It is
// structurally distinct from the step's structured data output so the
// test can verify which value surfaces in each field.
const FINAL_OUTPUT_SENTINEL = "FINAL_OUTPUT_SENTINEL";

// The step returns structured data — an object with a `rows` array. This is
// what the LAST STEP produces, NOT what the caller sees when an
// output_transform is present.
const STEP_STRUCTURED_OUTPUT = { rows: [{ a: 1 }, { a: 2 }] };

// Build a green-previewable draft with two observable layers that differ:
//   - layer 1: the transform step produces structured data (rows array)
//   - layer 2: the workflow-level output_transform (JSONata) turns that into
//     the FINAL_OUTPUT_SENTINEL string
// No connector, no output_schema — the draft is keyless and self-contained.
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
          // Step produces structured data: { rows: [{a:1},{a:2}] }
          expression: "return { rows: [{ a: 1 }, { a: 2 }] };",
        },
      ],
      // JSONata output_transform that returns a sentinel string regardless of
      // the step output, proving the FINAL output differs from the step output.
      output_transform: `"${FINAL_OUTPUT_SENTINEL}"`,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

// Build a draft WITHOUT an output_transform so the final output equals the
// last step's output. Used to confirm the fallback path.
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

    // The dry-run must succeed — the transform step and the output_transform
    // both run without errors.
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

    // PRIMARY ASSERTION: final_output is the sentinel string produced by the
    // workflow-level output_transform — NOT the step's structured { rows: [...] }.
    expect(data.final_output).toBe(FINAL_OUTPUT_SENTINEL);

    // The sentinel is a string; the step produced an object. They must differ.
    expect(data.final_output).not.toEqual(STEP_STRUCTURED_OUTPUT);

    // SECONDARY ASSERTION: the per-step trace still shows the STEP's structured
    // output (the transform adds final_output; it does not remove step traces).
    const makeRowsTrace = (data.step_trace ?? []).find((s) => s.step_id === "make_rows");
    expect(makeRowsTrace).toBeDefined();
    // The step output_preview is the structured data { rows: [{a:1},{a:2}] }
    // — the intermediate shape, not the sentinel.
    expect(makeRowsTrace?.output_preview).toEqual(STEP_STRUCTURED_OUTPUT);

    // No goal stashed — no auto-commit; ready to save explicitly.
    expect(data.auto_committed).toBe(false);
    expect(data.save_required).toBe(true);
  });

  test("latest_preview.preview is the post-output_transform final value, not the last step's output", async () => {
    const toolCtx = makeCtx(sentinelDraft("final-output-preview-field"));
    await dryRunWorkflowTool.execute(toolCtx, { input: null });

    const preview = toolCtx.current().latest_preview;
    expect(preview).toBeDefined();
    expect(preview?.ok).toBe(true);

    // The preview field must be the sentinel string (the final resolved output),
    // NOT the step's structured data. This is the core regression guard: before
    // the change, preview was lastStep.output_preview (the structured object);
    // after the change, it is finalOutputForLlm.data (the post-transform string).
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

    // When there is no output_transform, run.output IS the last step's output.
    // final_output must be present (the engine sets run.output to the last step's
    // value) and equal to the structured data the step produced.
    expect(data.final_output).toEqual(STEP_STRUCTURED_OUTPUT);

    // Step trace still present and consistent.
    const trace = (data.step_trace ?? []).find((s) => s.step_id === "make_rows");
    expect(trace).toBeDefined();
    expect(trace?.output_preview).toEqual(STEP_STRUCTURED_OUTPUT);

    // latest_preview.preview also reflects the last step's output when no
    // output_transform is present.
    const preview = toolCtx.current().latest_preview;
    expect(preview?.preview).toEqual(STEP_STRUCTURED_OUTPUT);
  });
});
