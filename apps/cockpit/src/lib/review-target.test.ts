// Approving the version that is already broken is not a smaller answer, it is
// the wrong one. These pin which version each surface hands to the approval.

import { expect, test } from "bun:test";
import { reviewTarget } from "./review-target";

const running = { current_version_id: "v-active", current_version: 14 };

test("a prepared draft is what gets judged, not the running version", () => {
  // The production case: 14 running, 15 prepared and repaired.
  const target = reviewTarget({ ...running, draft_version_id: "v-draft" });
  expect(target?.kind).toBe("prepared");
  expect(target?.version_id).toBe("v-draft");
  expect(target?.active_version).toBe(14);
  // Approving it must also activate it, in the same human decision.
  expect(target?.activation).toEqual({ expected_current_version_id: "v-active" });
});

test("without a prepared draft the running version is the target", () => {
  const target = reviewTarget({ ...running, draft_version_id: null });
  expect(target).toEqual({
    kind: "active",
    version_id: "v-active",
    version: 14,
    active_version: 14,
  });
  // No activation: there is nothing to activate, and passing one would ask the
  // person to confirm a change that is not happening.
  expect(target?.activation).toBeUndefined();
});

test("a draft pointer equal to the active version is not a prepared version", () => {
  // Activation folds the draft into the active version; until the pointer is
  // cleared the two ids can coincide, and that is not something to review.
  const target = reviewTarget({ ...running, draft_version_id: "v-active" });
  expect(target?.kind).toBe("active");
});

test("the draft body only supplies the number on the badge", () => {
  const prepared = { ...running, draft_version_id: "v-draft" };
  expect(reviewTarget(prepared, { version_id: "v-draft", version: 15 })?.version).toBe(15);
  // Not loaded, or loaded from a version that has since moved: the target is
  // unchanged, the label simply says less.
  expect(reviewTarget(prepared)?.version).toBeNull();
  expect(reviewTarget(prepared, { version_id: "v-older", version: 12 })?.version).toBeNull();
  expect(reviewTarget(prepared, { version_id: "v-older", version: 12 })?.version_id).toBe(
    "v-draft",
  );
});

test("a workflow with a prepared draft and nothing activated yet still reviews the draft", () => {
  const target = reviewTarget({
    current_version_id: null,
    current_version: null,
    draft_version_id: "v-draft",
  });
  expect(target?.kind).toBe("prepared");
  expect(target?.activation).toEqual({ expected_current_version_id: null });
  expect(target?.active_version).toBeNull();
});

test("nothing to review is null, never a guess", () => {
  expect(reviewTarget({ current_version_id: null, draft_version_id: null })).toBeNull();
  expect(reviewTarget(null)).toBeNull();
  expect(reviewTarget(undefined)).toBeNull();
});
