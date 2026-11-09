import { describe, expect, test } from "bun:test";
import { reviewTarget } from "./workflow-review-target.ts";

describe("reviewTarget", () => {
  test("has no target without a workflow or version", () => {
    expect(reviewTarget(null)).toBeNull();
    expect(reviewTarget({})).toBeNull();
  });

  test("prefers a prepared draft and keeps its activation precondition", () => {
    expect(
      reviewTarget(
        { current_version_id: "active", current_version: 4, draft_version_id: "draft" },
        { version_id: "draft", version: 5 },
      ),
    ).toEqual({
      kind: "prepared",
      version_id: "draft",
      version: 5,
      active_version: 4,
      activation: { expected_current_version_id: "active" },
    });
    expect(reviewTarget({ draft_version_id: "draft" })).toMatchObject({
      kind: "prepared",
      version_id: "draft",
      version: null,
      active_version: null,
      activation: { expected_current_version_id: null },
    });
  });

  test("uses the active version when no distinct draft is prepared", () => {
    expect(
      reviewTarget({
        current_version_id: "active",
        current_version: 4,
        draft_version_id: "active",
      }),
    ).toEqual({ kind: "active", version_id: "active", version: 4, active_version: 4 });
  });
});

test("a malformed draft identifier cannot become an activation target", () => {
  const raw = { current_version_id: "active", current_version: 4, draft_version_id: 42 };
  expect(reviewTarget(raw as unknown as Parameters<typeof reviewTarget>[0])).toEqual({
    kind: "active",
    version_id: "active",
    version: 4,
    active_version: 4,
  });
});
