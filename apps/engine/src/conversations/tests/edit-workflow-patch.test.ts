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
  test("adds a workflow-level per-run LLM token budget", async () => {
    const draftRef = { current: makeDraft() };
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [{ op: "add", path: "/max_llm_tokens_per_run", value: 70_000 }],
      },
    );
    expect(result.ok).toBe(true);
    expect(draftRef.current.workflow?.max_llm_tokens_per_run).toBe(70_000);
  });

  test("multi-op patch is applied atomically + persisted to the draft", async () => {
    const draftRef = { current: makeDraft() };
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [
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
        patches: [{ op: "replace", path: "/steps/0/kind", value: "totally_made_up_kind" }],
      },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string };
    expect(data.error_code).toBe("patch_invalid");
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("malformed patch path surfaces patch_invalid without mutating draft", async () => {
    const draftRef = { current: makeDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      {
        patches: [{ op: "replace", path: "/steps/9999/id", value: "ghost" }],
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("a patch that replaces steps with a non-array fails typed, not with a TypeError", async () => {
    const draftRef = { current: makeDraft() };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(
      makeCtx(() => draftRef.current, draftRef),
      { patches: [{ op: "replace", path: "/steps", value: { id: "not-a-list" } }] },
    );
    expect(result.ok).toBe(false);
    const data = result.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("patch_invalid");
    expect(data.message).toContain("steps");
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("input schema rejects an empty patch list", async () => {
    const draftRef = { current: makeDraft() };
    const ctxObj = makeCtx(() => draftRef.current, draftRef);
    expect(() => editWorkflowPatchTool.inputSchema.parse({ patches: [] })).toThrow();
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
