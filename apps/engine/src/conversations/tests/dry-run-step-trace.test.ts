// dry_run_workflow + run_workflow envelope must include a structured
// `step_trace` array per step so the LLM can pinpoint the failing
// step without paging through the run's full output.
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
    // Stateful draft holder so commitWorkflowAtomic's checkpoint
    // machinery sees the fresh `workflow_previewed` row the dry-run
    // writes — without it the green dry-run's auto-commit refuses with
    // `workflow_not_ready` (see the multi-step test below for the same
    // pattern).
    let draft: DraftDocument = {
      workflow: {
        name: "trace-clean",
        slug: "trace-clean",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return { doubled: input.input.value * 2 };",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
    } as any;
    const toolCtx: ToolContext = {
      ...makeCtx(() => draft),
      setDraft: async (next) => {
        draft = next;
      },
    };
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: { value: 21 } });
    // A clean dry-run of a valid draft auto-commits and returns ok.
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

  test("step_trace preserves kind for every step in a multi-step draft (auto-committed envelope)", async () => {
    // With auto-commit-on-green-dry-run the envelope returned by
    // dry_run_workflow is the committed-workflow shape — but
    // step_trace is forwarded to the new envelope so the LLM (and
    // downstream tests) can still inspect per-step shape + status.
    // The test uses a stateful draft holder so the checkpoint
    // machinery in commitWorkflowAtomic sees a fresh
    // `workflow_previewed` row after dry-run.
    let draft: DraftDocument = {
      workflow: {
        name: "trace-multi",
        slug: "trace-multi",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: "return input.input;",
          },
          {
            id: "second",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.shape.data;",
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
    } as any;
    const toolCtx: ToolContext = {
      ...makeCtx(() => draft),
      setDraft: async (next) => {
        draft = next;
      },
    };
    const result = await dryRunWorkflowTool.execute(toolCtx, {
      input: { hello: "world" },
    });
    const data = result.data as {
      step_trace?: Array<Record<string, unknown>>;
      auto_committed?: boolean;
    };
    // Either the auto-commit fired (preferred) or it refused on a
    // precondition — in both cases the step_trace must survive on
    // the returned envelope so the test contract holds. Pre-fix the
    // auto-committed envelope dropped step_trace entirely.
    expect(data.step_trace).toBeDefined();
    expect(data.step_trace!.map((o) => o.step_id)).toEqual(["shape", "second"]);
    expect(data.step_trace!.every((o) => o.kind === "transform")).toBe(true);
    expect(data.step_trace!.every((o) => o.status === "succeeded")).toBe(true);
  });

  test("include_step_results attaches raw per-step input/output; default stays compact (D6)", async () => {
    const seed = (): DraftDocument =>
      ({
        workflow: {
          name: "d6-step-results",
          slug: "d6-step-results",
          steps: [
            {
              id: "shape",
              kind: "transform",
              language: "javascript",
              expression: "return { doubled: input.input.value * 2 };",
            },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
      }) as any;

    // Default: no `step_results` field — the compact envelope carries only
    // the truncated `step_trace`.
    let draftA: DraftDocument = seed();
    const ctxA: ToolContext = {
      ...makeCtx(() => draftA),
      setDraft: async (next) => {
        draftA = next;
      },
    };
    const compact = await dryRunWorkflowTool.execute(ctxA, { input: { value: 21 } });
    expect((compact.data as Record<string, unknown>).step_results).toBeUndefined();

    // Opt-in: `step_results` carries the raw per-step input/output the model
    // uses to localise a bad output to a step vs the output_transform.
    let draftB: DraftDocument = seed();
    const ctxB: ToolContext = {
      ...makeCtx(() => draftB),
      setDraft: async (next) => {
        draftB = next;
      },
    };
    const raw = await dryRunWorkflowTool.execute(ctxB, {
      input: { value: 21 },
      include_step_results: true,
    });
    const results = (raw.data as { step_results?: Array<Record<string, unknown>> }).step_results;
    expect(Array.isArray(results)).toBe(true);
    expect(results!.length).toBe(1);
    const entry = results![0]!;
    expect(entry.step_id).toBe("shape");
    expect(entry.kind).toBe("transform");
    expect(entry.status).toBe("succeeded");
    // A transform issues no request → input is null, output carries the value.
    expect("input" in entry).toBe(true);
    expect(entry.input).toBeNull();
    expect(entry.output).toBeDefined();
  });
});
