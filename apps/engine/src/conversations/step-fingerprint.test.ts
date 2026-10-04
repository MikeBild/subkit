// Fingerprint-keyed preview evidence. Pins:
//   - fingerprint stability (canonical JSON — key order irrelevant)
//   - mutation-time pruning drops exactly the changed/removed steps
//   - `withLatestPreview` merges instead of replacing: a blocked
//     dry-run ("Preview blocked until the workflow draft validates
//     cleanly") must not destroy recorded evidence — the wipe that
//     deadlocked session 784c1b02.

import { describe, expect, test } from "bun:test";
import { withLatestPreview, withWorkflowDraft } from "./authoring-state.ts";
import { pruneTracesForMutation, stepFingerprint } from "./step-fingerprint.ts";
import type { DraftDocument, WorkflowDraftStepPreview } from "./types.ts";

const fetchStep = () => ({
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://example.com/items",
});

const shapeStep = () => ({
  id: "shape",
  kind: "transform",
  language: "javascript",
  expression: "return input.scope.fetch.data.items;",
});

function trace(step: Record<string, unknown>): WorkflowDraftStepPreview {
  return {
    step_id: String(step.id),
    kind: String(step.kind),
    status: "succeeded",
    fingerprint: stepFingerprint(step),
    output_preview: { items: [1, 2] },
    scope_at_step: {
      available_paths: ["items"],
      shape_summary: "object{items[2]}",
      primary_data_path: "items",
    },
  };
}

describe("stepFingerprint", () => {
  test("is stable under key reordering (canonical JSON)", () => {
    const a = { id: "s", kind: "request", method: "GET", url: "https://x" };
    const b = { url: "https://x", method: "GET", kind: "request", id: "s" };
    expect(stepFingerprint(a)).toBe(stepFingerprint(b));
  });

  test("changes when any field of the definition changes", () => {
    const base = fetchStep();
    expect(stepFingerprint(base)).not.toBe(stepFingerprint({ ...base, url: "https://other" }));
  });
});

describe("pruneTracesForMutation", () => {
  test("keeps evidence for unchanged steps, drops it for changed and removed ones", () => {
    const prev = [fetchStep(), shapeStep()];
    const next = [fetchStep(), { ...shapeStep(), expression: "return input.scope.fetch.data;" }];
    const kept = pruneTracesForMutation([trace(fetchStep()), trace(shapeStep())], prev, next);
    expect(kept.map((t) => t.step_id)).toEqual(["fetch"]);

    const removed = pruneTracesForMutation([trace(fetchStep())], prev, [shapeStep()]);
    expect(removed).toEqual([]);
  });

  test("fingerprintless traces are kept (and stamped) only when the definition is unchanged", () => {
    const unstamped: WorkflowDraftStepPreview = { ...trace(fetchStep()) };
    delete (unstamped as { fingerprint?: string }).fingerprint;
    const keptUnchanged = pruneTracesForMutation([unstamped], [fetchStep()], [fetchStep()]);
    expect(keptUnchanged).toHaveLength(1);
    expect(keptUnchanged[0]?.fingerprint).toBe(stepFingerprint(fetchStep()));

    const keptChanged = pruneTracesForMutation(
      [{ ...unstamped }],
      [fetchStep()],
      [{ ...fetchStep(), url: "https://other" }],
    );
    expect(keptChanged).toEqual([]);
  });
});

describe("withLatestPreview — fingerprint-keyed merge", () => {
  function draftWithEvidence(): DraftDocument {
    let draft = withWorkflowDraft(
      { workflow: { name: "wf", slug: "wf", steps: [] } } as unknown as DraftDocument,
      { name: "wf", slug: "wf", steps: [fetchStep(), shapeStep()] },
    );
    draft = withLatestPreview(draft, {
      ok: true,
      step_id: "shape",
      summary: "Preview ok.",
      step_traces: [trace(fetchStep()), trace(shapeStep())],
    });
    return draft;
  }

  test("a blocked preview (no step_traces) does NOT destroy recorded evidence", () => {
    const draft = draftWithEvidence();
    // The exact wipe path: dry_run refuses while the draft is mid-edit
    // invalid and records a trace-less "Preview blocked …" preview.
    const blocked = withLatestPreview(draft, {
      ok: false,
      step_id: "fetch",
      summary: "Preview blocked until the workflow draft validates cleanly.",
      preview: null,
    });
    const traces = blocked.latest_preview?.step_traces ?? [];
    expect(traces.map((t) => t.step_id).sort()).toEqual(["fetch", "shape"]);
    expect(blocked.latest_preview?.ok).toBe(false);
  });

  test("incoming traces win for their step ids; others survive fingerprint-valid", () => {
    const draft = draftWithEvidence();
    const merged = withLatestPreview(draft, {
      ok: true,
      step_id: "fetch",
      summary: "Single-step dry run.",
      step_traces: [
        {
          ...trace(fetchStep()),
          output_preview: { items: [9, 9, 9] },
        },
      ],
    });
    const traces = merged.latest_preview?.step_traces ?? [];
    const fetchTrace = traces.find((t) => t.step_id === "fetch");
    expect(fetchTrace?.output_preview).toEqual({ items: [9, 9, 9] });
    expect(traces.some((t) => t.step_id === "shape")).toBe(true);
  });
});
