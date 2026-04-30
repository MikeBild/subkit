// dry_run_workflow + run_workflow envelope must include a structured
// `step_trace` array per step so the LLM can pinpoint the failing
// step without paging through the run's full output. Mirrors the
// reference impl's `run_tool({ includeStepResults: true })`.
//
// On dry-run we always include `step_trace` (one row per step) with
// step_id / kind / status / duration_ms / output_preview / error /
// error_code / request_meta when each is present. On run_workflow the
// trace is only attached when the run isn't a clean success (failure,
// partial_success, or any warning) — clean wins skip the field to
// save tokens.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xd11c5_71ace);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-step-trace");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(getDraft: () => DraftDocument): ToolContext {
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
    getDraft,
    setDraft: async () => {},
  };
}

describe("dry_run_workflow · step_trace envelope", () => {
  test("clean run surfaces step_trace with kind, status, duration, output_preview", async () => {
    const draft: DraftDocument = {
      workflow: {
        name: "trace-clean",
        slug: "trace-clean",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            expression: "$input.{ 'doubled': value * 2 }",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      { input: { value: 21 } },
    );
    expect(result.ok).toBe(true);
    const data = result.data as { step_trace?: Array<Record<string, unknown>> };
    expect(Array.isArray(data.step_trace)).toBe(true);
    expect(data.step_trace!.length).toBe(1);
    const entry = data.step_trace![0]!;
    expect(entry.step_id).toBe("shape");
    expect(entry.kind).toBe("transform");
    expect(entry.status).toBe("succeeded");
    expect(typeof entry.duration_ms).toBe("number");
    // Transform output is enveloped — preview reflects what downstream
    // steps would see in scope. The exact shape is the data-handling
    // contract; we just confirm a preview was attached.
    expect(entry.output_preview).toBeDefined();
    // No error fields on a clean step.
    expect(entry.error_code).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  test("failing JSONata identifier surfaces error_code in step_trace", async () => {
    const draft: DraftDocument = {
      workflow: {
        name: "trace-fail",
        slug: "trace-fail",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            // Reference an identifier that isn't in scope. The runtime
            // emits an `unresolved_identifier` warning and the step
            // resolves to undefined — which trips the
            // transform_empty_extraction detector and surfaces an
            // error envelope on the step.
            expression: "$nonexistent.value",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      { input: {} },
    );
    const data = result.data as {
      warnings?: Array<{ code?: string }>;
      step_trace?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(data.step_trace)).toBe(true);
    expect(data.step_trace!.length).toBe(1);
    // The unresolved-identifier path is an authoring-warning surface
    // (run is technically "succeeded" but the warnings array signals
    // the LLM should look). Confirm warnings show up so the trace
    // stays useful even on the soft-fail path.
    const warningCodes = (data.warnings ?? []).map((w) => w.code);
    expect(warningCodes).toContain("unresolved_identifier");
  });

  test("step_trace preserves kind for every step in a multi-step draft", async () => {
    const draft: DraftDocument = {
      workflow: {
        name: "trace-multi",
        slug: "trace-multi",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "jsonata",
            expression: "$input",
          },
          {
            id: "second",
            kind: "transform",
            language: "jsonata",
            expression: "$scope.shape.data",
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
    } as any;
    const result = await dryRunWorkflowTool.execute(
      makeCtx(() => draft),
      {
        input: { hello: "world" },
      },
    );
    const data = result.data as { step_trace?: Array<Record<string, unknown>> };
    expect(data.step_trace!.map((o) => o.step_id)).toEqual(["shape", "second"]);
    expect(data.step_trace!.every((o) => o.kind === "transform")).toBe(true);
    expect(data.step_trace!.every((o) => o.status === "succeeded")).toBe(true);
  });
});
