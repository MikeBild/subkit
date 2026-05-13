// Cycle detection — pre-flight runs at build_workflow,
// dry_run_workflow, and edit_workflow_patch boundaries. A workflow
// whose `${scope.X}` placeholders form a loop is rejected with the
// typed `workflow_cycle_detected` error before it can persist.
//
// Sister test: dag.test.ts pins the pure-function correctness; this
// test pins the wiring at the conversation-tool boundary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xc91e7_dabc);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("cycle-rejected-at-build");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeAcyclicDraft(): DraftDocument {
  return {
    workflow: {
      name: "linear-ok",
      slug: "linear-ok",
      steps: [
        { id: "a", kind: "transform", language: "jsonata", expression: "$input" },
        { id: "b", kind: "transform", language: "jsonata", expression: "$scope.a.data" },
      ],
    },
    // Minimal latest_preview so the transform-authoring gate (v4.8.0)
    // doesn't fire on the fixture's pre-existing `$scope.a.data` ref.
    // The test is exercising cycle detection, not the inspect gate.
    latest_preview: {
      ok: true,
      summary: "preview seeded for test fixture",
      step_traces: [
        { step_id: "a", kind: "transform", status: "succeeded", output_preview: 1 },
        { step_id: "b", kind: "transform", status: "succeeded", output_preview: 2 },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
  } as any;
}

function makeCtx(
  getDraft: () => DraftDocument,
  setDraftRef: { current: DraftDocument },
): ToolContext {
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
    setDraft: async (next) => {
      setDraftRef.current = next;
    },
  };
}

describe("workflow_cycle_detected · edit_workflow_patch", () => {
  test("acyclic patch passes the pre-flight check", async () => {
    const draftRef = { current: makeAcyclicDraft() };
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          {
            op: "replace",
            path: "/steps/1/expression",
            value: "$scope.a.data * 2",
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
  });

  test("patch that introduces a 2-step cycle is rejected before persistence", async () => {
    const draftRef = { current: makeAcyclicDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          // Make `a` reference `b`, while `b` already references `a`.
          // Now a → b → a forms a cycle.
          {
            op: "replace",
            path: "/steps/0/expression",
            value: "$scope.b.data",
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; cycles?: unknown };
    expect(data.error_code).toBe("workflow_cycle_detected");
    // Draft must be byte-stable — partial application is never allowed.
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("patch that introduces a self-loop is rejected", async () => {
    const draftRef = { current: makeAcyclicDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          {
            op: "replace",
            path: "/steps/0/expression",
            value: "$scope.a.data",
          },
        ],
      },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    expect(data.error_code).toBe("workflow_cycle_detected");
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });
});
