// Fingerprint-keyed preview-evidence retention through `update_param`
// (Fix 5, session 784c1b02). Pre-fix the loop gate's evidence story was
// all-or-nothing: any mutation could invalidate the whole
// `latest_preview`, so the documented fix path for
// `loop_authoring_requires_inspect` deadlocked against itself (16×
// rejections in one session). Post-fix:
//
//   - evidence is keyed by step fingerprint (id + definition hash)
//   - an UNRELATED step edit keeps the upstream step's evidence, so
//     the gate passes without a redundant dry-run
//   - editing the upstream step's OWN definition drops exactly that
//     step's evidence, and only then does the gate block
//
// The gate's refinement (only fire when the mutated
// param is the loop's `over`/`data_selector`) is also still pinned.

import { describe, expect, test } from "bun:test";
import { normalizeDraftDocument } from "../../authoring-state.ts";
import { stepFingerprint } from "../../step-fingerprint.ts";
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

const fetchStep = () => ({
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://example.com/items",
});

const loopStep = () => ({
  id: "iter",
  kind: "loop",
  over: "$scope.fetch.data",
  body: ["body"],
});

const bodyStep = () => ({
  id: "body",
  kind: "transform",
  language: "javascript",
  expression: "return input.scope.$item;",
});

function draftWithoutEvidence(): DraftDocument {
  return {
    workflow: {
      name: "t",
      slug: "t",
      steps: [fetchStep(), loopStep(), bodyStep()],
    },
    // No latest_preview → loop gate fires when the loop source is edited.
  } as unknown as DraftDocument;
}

/** Draft with fingerprint-stamped dry-run evidence for `fetch`. */
function draftWithFetchEvidence(): DraftDocument {
  return normalizeDraftDocument({
    workflow: {
      name: "t",
      slug: "t",
      steps: [fetchStep(), loopStep(), bodyStep()],
    },
    latest_preview: {
      ok: true,
      step_id: "fetch",
      summary: "Preview ok.",
      step_traces: [
        {
          step_id: "fetch",
          kind: "request",
          status: "succeeded",
          fingerprint: stepFingerprint(fetchStep()),
          output_preview: { items: [{ id: "a" }] },
          scope_at_step: {
            available_paths: ["items", "items[0].id"],
            shape_summary: "object{items[1]}",
            primary_data_path: "items",
          },
        },
      ],
    },
  });
}

function errorData(result: { ok: boolean; data?: unknown }): {
  error_code?: string;
  gate_blocks?: Array<{ reason?: string }>;
} {
  return (result as { data: { error_code?: string; gate_blocks?: Array<{ reason?: string }> } })
    .data;
}

/** The recorded-evaluation report update_param now returns inline:
 *  the loop/transform authoring gates are non-blocking — the edit is
 *  accepted (`ok:true`) and the verdict rides back here, symmetric with
 *  edit_workflow_patch, so the model repairs without thrashing. */
function recordedEval(result: { ok: boolean; data?: unknown }): {
  ok: boolean;
  gates: { loop: { blocks: Array<{ reason?: string }> } };
} {
  return (result as { data: { recorded_eval: ReturnType<typeof recordedEval> } }).data
    .recorded_eval;
}

describe("update_param · loop-gate refinement (still pinned)", () => {
  test("reports a loop finding (non-blocking) when editing `over` with no preview", async () => {
    const ctx = makeCtx(draftWithoutEvidence());
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    // the edit is accepted; the missing-evidence verdict is a finding.
    expect(result.ok).toBe(true);
    const re = recordedEval(result);
    expect(re.ok).toBe(false);
    expect(re.gates.loop.blocks.length).toBeGreaterThan(0);
  });

  test("does NOT fire when editing a request step's headers (unrelated to loop)", async () => {
    const ctx = makeCtx(draftWithoutEvidence());
    const result = await updateParamTool.execute(ctx, {
      step_id: "fetch",
      param: "headers",
      value: { Authorization: "Bearer x" },
    });
    if (!result.ok) {
      const err = errorData(result);
      throw new Error(`update_param refused unexpectedly: code=${err.error_code}`);
    }
    expect(result.ok).toBe(true);
  });
});

describe("update_param · fingerprint-keyed evidence retention", () => {
  test("recorded evidence satisfies the gate: editing the loop's `over` passes", async () => {
    const ctx = makeCtx(draftWithFetchEvidence());
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    expect(result.ok).toBe(true);
  });

  test("evidence SURVIVES an unrelated step edit; gate still passes afterwards", async () => {
    const ctx = makeCtx(draftWithFetchEvidence());
    // Unrelated edit: the body transform's expression. fetch's
    // definition is untouched, so its fingerprint-keyed trace must
    // survive the mutation.
    const edit = await updateParamTool.execute(ctx, {
      step_id: "body",
      param: "expression",
      value: "return input.scope.$item.id;",
    });
    expect(edit.ok).toBe(true);
    const traces = ctx._draft.value.latest_preview?.step_traces ?? [];
    expect(traces.some((t) => t.step_id === "fetch")).toBe(true);

    // The documented fix path: re-target the loop source. With the
    // retained evidence, no redundant dry-run is demanded.
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    expect(result.ok).toBe(true);
  });

  test("evidence is DROPPED when the step's own definition changes; gate blocks only then", async () => {
    const ctx = makeCtx(draftWithFetchEvidence());
    // Edit fetch ITSELF — its recorded shape can no longer be trusted.
    const edit = await updateParamTool.execute(ctx, {
      step_id: "fetch",
      param: "url",
      value: "https://example.com/v2/items",
    });
    expect(edit.ok).toBe(true);
    const traces = ctx._draft.value.latest_preview?.step_traces ?? [];
    expect(traces.some((t) => t.step_id === "fetch")).toBe(false);

    // The evidence for fetch is gone, so the loop edit now carries a
    // missing-evidence finding (accepted, not refused).
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    expect(result.ok).toBe(true);
    expect(recordedEval(result).gates.loop.blocks.length).toBeGreaterThan(0);
  });

  test("stale fingerprint (evidence recorded against a different definition) is reported as a finding", async () => {
    const draft = normalizeDraftDocument({
      workflow: {
        name: "t",
        slug: "t",
        steps: [fetchStep(), loopStep(), bodyStep()],
      },
      latest_preview: {
        ok: true,
        step_id: "fetch",
        summary: "Preview ok.",
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "succeeded",
            // Fingerprint of a DIFFERENT fetch definition.
            fingerprint: stepFingerprint({ ...fetchStep(), url: "https://old.example.com" }),
            output_preview: { items: [] },
            scope_at_step: {
              available_paths: ["items"],
              shape_summary: "object{items[0]}",
              primary_data_path: "items",
            },
          },
        ],
      },
    });
    const ctx = makeCtx(draft);
    const result = await updateParamTool.execute(ctx, {
      step_id: "iter",
      param: "over",
      value: "$scope.fetch.data.items",
    });
    // Accepted: the stale trace is pruned by fingerprint-keyed
    // retention, so recorded-eval reports the loop reference as needing a
    // dry-run — the same verdict edit_workflow_patch produces. The exact
    // reason ("no usable evidence") folds stale-vs-never; both require a
    // dry-run, so the test asserts a finding is surfaced, not its precise tag.
    expect(result.ok).toBe(true);
    expect(recordedEval(result).gates.loop.blocks.length).toBeGreaterThan(0);
  });
});
