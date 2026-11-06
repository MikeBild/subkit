import { describe, expect, it } from "bun:test";
import {
  createEmptyDraftDocument,
  hasInProgressWorkflowDraft,
  startNewWorkflowDraft,
  withWorkflowDraft,
  withWorkflowPersisted,
} from "../authoring-state/index.ts";
import type { DraftDocument } from "../types.ts";

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
    const base = withSomeSteps(createEmptyDraftDocument(), "persisted-wf");
    const draft = withPersistedWorkflow(base, "persisted-wf");
    expect(hasInProgressWorkflowDraft(draft)).toBe(false);
  });

  it("returns true for an in-progress draft even when a DIFFERENT persisted workflow is present", () => {
    const base = withSomeSteps(createEmptyDraftDocument(), "new-wf");
    const draft = withPersistedWorkflow(base, "old-wf");
    expect(hasInProgressWorkflowDraft(draft)).toBe(true);
  });

  it("returns false for a completely empty draft", () => {
    expect(hasInProgressWorkflowDraft(createEmptyDraftDocument())).toBe(false);
  });
});

describe("startNewWorkflowDraft clears persisted binding", () => {
  it("after startNewWorkflowDraft, hasInProgressWorkflowDraft returns false (empty draft)", () => {
    const withSteps = withSomeSteps(createEmptyDraftDocument(), "some-wf");
    const persisted = withPersistedWorkflow(withSteps, "some-wf");
    const reset = startNewWorkflowDraft(persisted);
    expect(reset.workflow?.steps ?? []).toHaveLength(0);
    expect(hasInProgressWorkflowDraft(reset)).toBe(false);
  });
});
