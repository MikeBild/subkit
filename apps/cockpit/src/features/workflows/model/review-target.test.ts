import { expect, test } from "bun:test";
import { reviewTarget } from "@/features/workflows/model/review-target";

const running = { current_version_id: "v-active", current_version: 14 };

test("a prepared draft is what gets judged, not the running version", () => {
  const target = reviewTarget({ ...running, draft_version_id: "v-draft" });
  expect(target?.kind).toBe("prepared");
  expect(target?.version_id).toBe("v-draft");
  expect(target?.active_version).toBe(14);
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
  expect(target?.activation).toBeUndefined();
});

test("a draft pointer equal to the active version is not a prepared version", () => {
  const target = reviewTarget({ ...running, draft_version_id: "v-active" });
  expect(target?.kind).toBe("active");
});

test("the draft body only supplies the number on the badge", () => {
  const prepared = { ...running, draft_version_id: "v-draft" };
  expect(reviewTarget(prepared, { version_id: "v-draft", version: 15 })?.version).toBe(15);
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
