// update_param's loop-authoring gate refinement (#10): the gate only
// fires when the param being mutated is a loop's `over` /
// `data_selector`. Pre-fix the gate fired for any update_param
// against a workflow that contained any loop step, blocking the
// documented fix path for `loop_authoring_requires_inspect`.

import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { updateParamTool } from "../update-param.ts";

function makeCtx(initialDraft: DraftDocument): ToolContext & { _draft: { value: DraftDocument } } {
  const ref = { value: initialDraft };
  return {
    db: {} as ToolContext["db"],
    tenant_id: "00000000-0000-0000-0000-000000000000",
    conversation_id: "11111111-1111-1111-1111-111111111111",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => ref.value,
    setDraft: async (d) => {
      ref.value = d;
    },
    _draft: ref,
  };
}

const draftWithLoopAndOtherStep = (): DraftDocument =>
  ({
    workflow: {
      name: "t",
      slug: "t",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://example.com/items",
        },
        {
          id: "iter",
          kind: "loop",
          over: "$scope.fetch.data",
          item_var: "x",
          body: ["body"],
        },
        {
          id: "body",
          kind: "transform",
          language: "jsonata",
          expression: "$x",
        },
      ],
    },
    // No latest_preview → loop gate would fire if applied.
  }) as unknown as DraftDocument;

describe("update_param · loop-gate refinement", () => {
  test("fires when editing the loop step's `over` field with no preview", async () => {
    const ctx = makeCtx(draftWithLoopAndOtherStep());
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    expect(result.ok).toBe(false);
    const data = (result as { data: { error_code?: string } }).data;
    expect(data.error_code).toBe("loop_authoring_requires_inspect");
  });

  test("does NOT fire when editing a non-loop step (the documented fix path)", async () => {
    const ctx = makeCtx(draftWithLoopAndOtherStep());
    // The user is fixing the `body` transform expression — unrelated
    // to the loop. Pre-fix this would still trip the loop gate
    // because the workflow contains a loop. Post-fix it's unblocked.
    const result = await updateParamTool.execute(ctx, {
      step_id: "body",
      param: "expression",
      value: "$x.id",
    });
    expect(result.ok).toBe(true);
  });

  test("does NOT fire when editing a request step's headers (unrelated to loop)", async () => {
    const ctx = makeCtx(draftWithLoopAndOtherStep());
    const result = await updateParamTool.execute(ctx, {
      step_id: "fetch",
      param: "headers",
      value: { Authorization: "Bearer x" },
    });
    if (!result.ok) {
      const err = (result as { data?: { error_code?: string; message?: string } }).data;
      throw new Error(
        `update_param refused unexpectedly: code=${err?.error_code} msg=${err?.message}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});
