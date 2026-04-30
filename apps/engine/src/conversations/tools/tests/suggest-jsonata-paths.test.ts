// suggest_jsonata_paths — read-only tool that returns ranked
// JSONata path candidates from a step's recorded preview. Pure-ish:
// uses an in-memory draft via a fake context.

import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { suggestJsonataPathsTool } from "../suggest-jsonata-paths.ts";

function makeCtx(draft: DraftDocument): ToolContext {
  let current = draft;
  return {
    db: {} as ToolContext["db"],
    tenant_id: "00000000-0000-0000-0000-000000000000",
    conversation_id: "11111111-1111-1111-1111-111111111111",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => current,
    setDraft: async (next) => {
      current = next;
    },
  };
}

const baseDraft: DraftDocument = {
  workflow: { name: "t", steps: [] },
  latest_preview: {
    ok: true,
    summary: "x",
    step_traces: [
      {
        step_id: "fetch",
        kind: "request",
        status: "succeeded",
        output_preview: {
          data: {
            results: [
              { id: 1, name: "Ada", email: "ada@example.com" },
              { id: 2, name: "Babbage", email: "ch@example.com" },
            ],
            count: 2,
          },
        },
        scope_at_step: {
          available_paths: [
            "data",
            "data.results",
            "data.results[0]",
            "data.results[0].id",
            "data.results[0].name",
            "data.results[0].email",
            "data.results[*]",
            "data.count",
          ],
          shape_summary: "object{data}",
          primary_data_path: "data.results",
        },
      },
    ],
  },
};

describe("suggest_jsonata_paths", () => {
  test("returns paths prefixed with $scope.<step_id>", async () => {
    const ctx = makeCtx(baseDraft);
    const result = await suggestJsonataPathsTool.execute(ctx, { step_id: "fetch", limit: 5 });
    expect(result.ok).toBe(true);
    const data = (result as { data: { candidates: Array<{ jsonata: string }> } }).data;
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates[0]!.jsonata.startsWith("$scope.fetch.")).toBe(true);
  });

  test("filters by search_key regex (key match)", async () => {
    const ctx = makeCtx(baseDraft);
    const result = await suggestJsonataPathsTool.execute(ctx, {
      step_id: "fetch",
      search_key: "^email$",
      limit: 10,
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { candidates: Array<{ jsonata: string }> } }).data;
    expect(data.candidates.some((c) => c.jsonata.endsWith(".email"))).toBe(true);
  });

  test("filters by search_value substring (value match)", async () => {
    const ctx = makeCtx(baseDraft);
    const result = await suggestJsonataPathsTool.execute(ctx, {
      step_id: "fetch",
      search_value: "ada@",
      limit: 10,
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { candidates: Array<{ jsonata: string }> } }).data;
    expect(data.candidates.some((c) => c.jsonata.endsWith(".email"))).toBe(true);
  });

  test("returns no_preview_recorded when the draft has no traces", async () => {
    const ctx = makeCtx({
      workflow: { name: "t", steps: [] },
    });
    const result = await suggestJsonataPathsTool.execute(ctx, { step_id: "fetch" });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("no_preview_recorded");
  });

  test("returns step_not_in_preview when step_id is unknown", async () => {
    const ctx = makeCtx(baseDraft);
    const result = await suggestJsonataPathsTool.execute(ctx, { step_id: "missing" });
    expect(result.ok).toBe(false);
    expect((result as { error_code?: string }).error_code).toBe("step_not_in_preview");
  });
});
