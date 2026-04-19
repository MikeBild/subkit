import { describe, expect, test } from "bun:test";
import {
  createEmptyDraftDocument,
  normalizeDraftDocument,
  withWorkflowDraft,
} from "./authoring-state.ts";

describe("authoring-state", () => {
  test("createEmptyDraftDocument stores the workflow only in draft.workflow", () => {
    const draft = createEmptyDraftDocument();
    expect(draft.workflow.name).toBe("new-workflow");
    expect(draft.workflow.steps).toEqual([]);
    expect("name" in (draft as unknown as Record<string, unknown>)).toBe(false);
    expect("steps" in (draft as unknown as Record<string, unknown>)).toBe(false);
  });

  test("normalizeDraftDocument prefers the nested workflow shape", () => {
    const draft = normalizeDraftDocument({
      name: "stale-top-level",
      steps: [{ id: "top", kind: "wait", duration_ms: 1 }],
      workflow: {
        name: "nested-workflow",
        steps: [{ id: "nested", kind: "wait", duration_ms: 2 }],
      },
    });
    expect(draft.workflow.name).toBe("nested-workflow");
    expect(draft.workflow.steps[0]).toEqual({ id: "nested", kind: "wait", duration_ms: 2 });
  });

  test("withWorkflowDraft keeps the canonical nested shape", () => {
    const draft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "daily-sync",
      slug: "daily-sync",
      steps: [{ id: "fetch", kind: "request", url: "https://example.com" }],
    });
    expect(draft.workflow.slug).toBe("daily-sync");
    expect("slug" in (draft as unknown as Record<string, unknown>)).toBe(false);
  });
});
