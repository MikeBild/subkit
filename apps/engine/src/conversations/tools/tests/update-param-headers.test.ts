// update_param's targeted guard for `param: "headers"`. Without this
// guard the LLM's repair loop in conversation 730c568a stored
// `headers = '{"Accept": "application/vnd.github+json"}'` (a JSON
// string) which slipped past the workflow draft's lenient string
// coercion, then crashed `new Headers()` at fetch time with the
// uninformative "Invalid header name: '{\"Accept\"'" error. The
// retry loop misclassified the crash as a transient connection error
// and retried 5×.

import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { updateParamTool } from "../update-param.ts";

function makeCtx(initialDraft: DraftDocument): ToolContext {
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
  };
}

const draftWithRequestStep = (): DraftDocument =>
  ({
    workflow: {
      name: "t",
      slug: "t",
      steps: [
        {
          id: "fetch_repos",
          kind: "request",
          method: "GET",
          path: "/user/repos",
          connector_id: "584ef58a-c4dd-454c-bfb8-7dd0925ccb1e",
          headers: { Accept: "application/json" },
        },
      ],
    },
  }) as unknown as DraftDocument;

describe("update_param · headers JSON-string guard", () => {
  test("rejects a JSON-encoded object string assigned to headers", async () => {
    const ctx = makeCtx(draftWithRequestStep());
    const res = await updateParamTool.execute(ctx, {
      step_id: "fetch_repos",
      param: "headers",
      value: '{"Accept": "application/vnd.github+json"}',
    });
    expect(res.ok).toBe(false);
    const data = res.data as { error_code?: string; message?: string };
    expect(data.error_code).toBe("step_update_invalid");
    expect(data.message).toMatch(/headers must be an object/i);
  });

  test("rejects a JSON-encoded array string assigned to headers", async () => {
    const ctx = makeCtx(draftWithRequestStep());
    const res = await updateParamTool.execute(ctx, {
      step_id: "fetch_repos",
      param: "headers",
      value: '[["Accept","application/json"]]',
    });
    expect(res.ok).toBe(false);
  });

  test("accepts a proper object headers value", async () => {
    const ctx = makeCtx(draftWithRequestStep());
    const res = await updateParamTool.execute(ctx, {
      step_id: "fetch_repos",
      param: "headers",
      value: { Accept: "application/vnd.github+json" },
    });
    expect(res.ok).toBe(true);
  });

  test("accepts a per-key headers update via dotted path (the documented repair pattern)", async () => {
    const ctx = makeCtx(draftWithRequestStep());
    const res = await updateParamTool.execute(ctx, {
      step_id: "fetch_repos",
      param: "headers.Accept",
      value: "application/vnd.github+json",
    });
    expect(res.ok).toBe(true);
  });
});
