// edit_workflow_patch — RFC 6902 over the workflow draft. The applied
// patch must produce a draft that still validates against WorkflowDef Zod;
// partial application is never persisted.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0xed17_a17c5);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("edit-workflow-patch");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeDraft(): DraftDocument {
  return {
    workflow: {
      name: "shape-flow",
      slug: "shape-flow",
      steps: [
        {
          id: "fetch",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.fetch.data;",
        },
      ],
    },
    // Minimal latest_preview so the transform-authoring gate is
    // satisfied for the fixture's pre-existing `$scope.fetch.data`
    // ref (v4.8.1). Without this, post-patch states that introduce
    // new transforms would correctly be blocked — but the test
    // intent is to exercise patch mechanics, not the gate. Pinning a
    // preview here mirrors what every realistic production draft has
    // by the time it reaches `edit_workflow_patch`.
    latest_preview: {
      ok: true,
      summary: "preview seeded for test fixture",
      step_traces: [
        {
          step_id: "fetch",
          kind: "transform",
          status: "succeeded",
          output_preview: { value: 1 },
        },
        {
          step_id: "shape",
          kind: "transform",
          status: "succeeded",
          output_preview: { shaped: 1 },
        },
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

describe("edit_workflow_patch", () => {
  test("multi-op patch is applied atomically + persisted to the draft", async () => {
    const draftRef = { current: makeDraft() };
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          // Rename the first step + retarget the reference in the
          // second step's expression. Two ops, applied as one.
          { op: "replace", path: "/steps/0/id", value: "load" },
          {
            op: "replace",
            path: "/steps/1/expression",
            value: "return input.scope.load.data;",
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    const wf = (
      draftRef.current as unknown as {
        workflow: { steps: Array<{ id: string; expression?: string }> };
      }
    ).workflow;
    expect(wf.steps[0]!.id).toBe("load");
    expect(wf.steps[1]!.expression).toBe("return input.scope.load.data;");
    expect(wf.steps).toHaveLength(2);
  });

  test("patch that produces an invalid draft is rejected with patch_invalid + draft unchanged", async () => {
    const draftRef = { current: makeDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          // Set kind to an unknown value — the discriminated union
          // rejects this, so the patched draft fails validation.
          { op: "replace", path: "/steps/0/kind", value: "totally_made_up_kind" },
        ],
      },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    expect(data.error_code).toBe("patch_invalid");
    // Draft must be byte-stable since the patch failed.
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("malformed patch path surfaces patch_invalid without mutating draft", async () => {
    const draftRef = { current: makeDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          // Path points at a nonexistent field — fast-json-patch
          // throws on `replace` against a missing path.
          { op: "replace", path: "/steps/9999/id", value: "ghost" },
        ],
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("input schema rejects an empty patch list", async () => {
    const draftRef = { current: makeDraft() };
    const ctxObj = makeCtx(() => draftRef.current, draftRef);
    expect(() => editWorkflowPatchTool.inputSchema.parse({ patches: [] })).toThrow();
    // We don't call execute() — the inputSchema parse is the contract.
    void ctxObj;
  });

  test("add operation extends the steps array and validates", async () => {
    const draftRef = { current: makeDraft() };
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
          {
            op: "add",
            path: "/steps/-",
            value: {
              id: "tail",
              kind: "transform",
              language: "javascript",
              expression: "return input.scope.shape.data;",
            },
          },
        ],
      },
    );
    expect(result.ok).toBe(true);
    const wf = (draftRef.current as unknown as { workflow: { steps: Array<{ id: string }> } })
      .workflow;
    expect(wf.steps).toHaveLength(3);
    expect(wf.steps[2]!.id).toBe("tail");
  });
});
