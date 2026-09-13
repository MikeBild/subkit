// dry_run_workflow · failure surfacing.
//
// A failed dry-run (a step that errors, or a judge block, or a structural
// repair-need) returns `ok:false` with a STABLE top-level `error_code` plus a
// human `message`. Before this contract the reason lived only inside `data`
// (data.summary / data.classification), so two consumers went blind:
//   1. `summarizeToolFailure` (the tool.failed log) read top-level fields →
//      logged `undefined` (the exact symptom the keyed browserless benchmark
//      surfaced: "tool.failed [dry_run_workflow] — undefined", 6–16× per run).
//   2. the error_code-repeat breaker reads the result payload → with no
//      trackable code it could not short-circuit a model re-issuing the same
//      failing preview.
// This test locks the top-level surfacing AND that summarizeToolFailure lifts it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import { summarizeToolFailure } from "../tools/sdk-wrap/policy-helpers.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xfa11_03);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dry-run-failure-surfacing");
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

// A draft whose only step throws → the dry-run run fails on that step. Keyless
// and self-contained (a JS transform that throws).
function failingDraft(slug: string): DraftDocument {
  return {
    workflow: {
      name: slug,
      slug,
      steps: [
        {
          id: "boom",
          kind: "transform",
          language: "javascript",
          expression: "throw new Error('intentional step failure');",
        },
      ],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fixture
  } as any;
}

describe("dry_run_workflow · failure surfacing", () => {
  test("a failed dry-run returns ok:false with a top-level error_code + message", async () => {
    const toolCtx = makeCtx(failingDraft("dry-run-failure-surfacing-step"));
    const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
      ok: boolean;
      error_code?: string;
      message?: string;
    };

    expect(result.ok).toBe(false);
    // Stable, non-empty code (draft_step_failed[:<step-code>] or preview_*).
    expect(typeof result.error_code).toBe("string");
    expect((result.error_code ?? "").length).toBeGreaterThan(0);
    // Human message present (the same summary the model reads).
    expect(typeof result.message).toBe("string");
    expect((result.message ?? "").length).toBeGreaterThan(0);
  });

  test("summarizeToolFailure lifts that reason into the log (no more `undefined`)", async () => {
    const toolCtx = makeCtx(failingDraft("dry-run-failure-surfacing-log"));
    const result = (await dryRunWorkflowTool.execute(toolCtx, { input: null })) as {
      ok: boolean;
      error_code?: string;
      message?: string;
      data?: unknown;
    };

    const summary = summarizeToolFailure(result);
    // The log line now carries a code + an error string — not undefined.
    expect(typeof summary.error_code).toBe("string");
    expect((summary.error_code ?? "").length).toBeGreaterThan(0);
    expect(typeof summary.error).toBe("string");
    expect((summary.error ?? "").length).toBeGreaterThan(0);
  });
});
