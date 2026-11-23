import { expect, test } from "bun:test";
import { type ApprovalFacts, approvalRefusal } from "./approval-refusal.ts";

const WHOLE: ApprovalFacts = {
  selection_requested: false,
  partial: false,
  review_reason: null,
  review_digest: "d1",
  expected_review_digest: "d1",
  tested_digest: null,
};

test("the whole repair needs only the reviewed digest, and none from a trusted caller", () => {
  expect(approvalRefusal(WHOLE)).toBeNull();
  expect(approvalRefusal({ ...WHOLE, expected_review_digest: null })).toBeNull();
  expect(approvalRefusal({ ...WHOLE, selection_requested: true })).toBeNull();
  expect(
    approvalRefusal({
      ...WHOLE,
      review_digest: null,
      review_reason: "step_not_found",
      expected_review_digest: null,
    }),
  ).toBeNull();
});

test("a digest that no longer matches is refused with the current reason", () => {
  expect(approvalRefusal({ ...WHOLE, expected_review_digest: "d0" })).toBe("review_changed");
  expect(approvalRefusal({ ...WHOLE, review_digest: null, review_reason: "no_change" })).toBe(
    "no_change",
  );
});

test("a part of the repair needs a dry run of exactly that part", () => {
  const part = { ...WHOLE, selection_requested: true, partial: true };
  expect(approvalRefusal({ ...part, tested_digest: "d1" })).toBeNull();
  expect(approvalRefusal(part)).toBe("dry_run_required");
  expect(approvalRefusal({ ...part, tested_digest: "d2" })).toBe("dry_run_required");
  expect(approvalRefusal({ ...part, tested_digest: "d1", expected_review_digest: null })).toBe(
    "dry_run_required",
  );
  expect(approvalRefusal({ ...part, tested_digest: "d2", expected_review_digest: "d2" })).toBe(
    "review_changed",
  );
});

test("an invalid selection is refused before anything else", () => {
  expect(
    approvalRefusal({
      ...WHOLE,
      selection_requested: true,
      review_digest: null,
      review_reason: "accepted_operations_invalid",
      expected_review_digest: null,
    }),
  ).toBe("accepted_operations_invalid");
  expect(approvalRefusal({ ...WHOLE, selection_requested: true, review_digest: null })).toBe(
    "accepted_operations_invalid",
  );
});
