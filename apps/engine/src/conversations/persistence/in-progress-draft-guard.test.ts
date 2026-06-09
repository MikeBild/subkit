// Unit tests for the hasInProgressWorkflowDraft guard logic (loop.ts ~line 279).
//
// The guard prevents a "start new workflow" intent from wiping an
// in-progress (non-persisted) draft that already has steps. Only an
// already-persisted target may be reset; an unsaved in-flight draft
// with steps must be preserved.
//
// Test matrix (B.2):
//   - in-progress draft with steps + persisted workflow present
//     → guard fires, draft is NOT a candidate for reset.
//   - empty in-progress draft with persisted workflow + startNewWorkflow
//     intent → guard does NOT fire (empty drafts may reset).
//   - in-progress draft whose slug matches a persisted_resources entry
//     → that means it IS persisted; guard does NOT fire.

import { describe, expect, it } from "bun:test";
import {
  createEmptyDraftDocument,
  startNewWorkflowDraft,
  withWorkflowDraft,
  withWorkflowPersisted,
} from "../authoring-state.ts";
import type { DraftDocument } from "../types.ts";

/** Mirror of the condition in loop.ts ~line 279 */
function hasInProgressWorkflowDraft(draft: DraftDocument): boolean {
  return (
    (draft.workflow?.steps.length ?? 0) > 0 &&
    !draft.summary?.persisted_resources.some(
      (resource) => resource.kind === "workflow" && resource.slug === draft.workflow?.slug,
    )
  );
}

function withSomeSteps(draft: DraftDocument, slug = "my-wf"): DraftDocument {
  return withWorkflowDraft(draft, {
    name: slug,
    slug,
    steps: [{ id: "step1", kind: "transform", expression: "$input" }],
  });
}

function withPersistedWorkflow(draft: DraftDocument, slug = "my-wf"): DraftDocument {
  return withWorkflowPersisted(
    draft,
    {
      kind: "workflow",
      id: "wf-123",
      slug,
      name: slug,
      version_id: "wfv-1",
      version: 1,
      environment: null,
      saved_at: "2026-01-01T00:00:00.000Z",
    },
    "workflow_saved",
  );
}

describe("hasInProgressWorkflowDraft guard", () => {
  it("returns true when the draft has steps and the slug is NOT in persisted_resources", () => {
    const draft = withSomeSteps(createEmptyDraftDocument(), "fresh-wf");
    expect(hasInProgressWorkflowDraft(draft)).toBe(true);
  });

  it("returns false when the draft has no steps (empty unsaved draft)", () => {
    const draft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "empty-wf",
      slug: "empty-wf",
      steps: [],
    });
    expect(hasInProgressWorkflowDraft(draft)).toBe(false);
  });

  it("returns false when the draft's slug matches a persisted_resources workflow entry", () => {
    // A draft whose slug appears in persisted_resources IS persisted — not in-progress.
    const base = withSomeSteps(createEmptyDraftDocument(), "persisted-wf");
    const draft = withPersistedWorkflow(base, "persisted-wf");
    expect(hasInProgressWorkflowDraft(draft)).toBe(false);
  });

  it("returns true for an in-progress draft even when a DIFFERENT persisted workflow is present", () => {
    // Persisted resource is for "old-wf"; the in-progress draft is "new-wf".
    // The guard must fire (don't overwrite the new-wf draft).
    const base = withSomeSteps(createEmptyDraftDocument(), "new-wf");
    const draft = withPersistedWorkflow(base, "old-wf");
    // Manually overwrite the workflow draft slug to simulate the pivot scenario.
    expect(hasInProgressWorkflowDraft(draft)).toBe(true);
  });

  it("returns false for a completely empty draft", () => {
    expect(hasInProgressWorkflowDraft(createEmptyDraftDocument())).toBe(false);
  });
});

describe("startNewWorkflowDraft clears persisted binding", () => {
  it("after startNewWorkflowDraft, hasInProgressWorkflowDraft returns false (empty draft)", () => {
    const withSteps = withSomeSteps(createEmptyDraftDocument(), "some-wf");
    // Attach a persisted resource so the guard doesn't fire on the original draft.
    const persisted = withPersistedWorkflow(withSteps, "some-wf");
    const reset = startNewWorkflowDraft(persisted);
    // Empty steps → not in-progress
    expect(reset.workflow?.steps ?? []).toHaveLength(0);
    expect(hasInProgressWorkflowDraft(reset)).toBe(false);
  });
});
