import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  approvalFailureOf,
  type CandidateReviewFacts,
  decideCandidateReview,
  skillReviewDigest,
} from "./review.ts";

const facts: CandidateReviewFacts = {
  tenant_id: "tenant",
  id: "candidate",
  scope: "workflow",
  connector_id: "connector",
  endpoint_key: "/items",
  workflow_id: "workflow",
  title: "title",
  body: "body",
  examples: { examples: ["example"], pitfalls: [] },
  tags: ["tag"],
};

test("review digest binds every review field and preserves its historical digest contract", () => {
  const original = skillReviewDigest(facts);
  expect(original).toMatch(/^[0-9a-f]{64}$/);
  for (const field of [
    "tenant_id",
    "id",
    "scope",
    "connector_id",
    "endpoint_key",
    "workflow_id",
    "title",
    "body",
  ] as const)
    expect(skillReviewDigest({ ...facts, [field]: "changed" })).not.toBe(original);
  expect(skillReviewDigest({ ...facts, examples: null })).not.toBe(original);
  expect(skillReviewDigest({ ...facts, tags: ["other"] })).not.toBe(original);
  expect(skillReviewDigest({ ...facts, tags: null })).not.toBe(original);
});

test("canonical review digest ignores object key order and fields outside the review contract", () => {
  const reversedExamples = { pitfalls: [], examples: ["example"] };
  expect(skillReviewDigest({ ...facts, examples: reversedExamples })).toBe(
    skillReviewDigest(facts),
  );
  const withRuntimeMetadata = { ...facts, status: "approved", version: 999, updated_at: "later" };
  expect(skillReviewDigest(withRuntimeMetadata)).toBe(skillReviewDigest(facts));
});

test("hashing frozen review facts is deterministic and never mutates them", () => {
  fc.assert(
    fc.property(fc.string(), fc.array(fc.string(), { maxLength: 10 }), (body, tags) => {
      const record = Object.freeze({ ...facts, body, tags: Object.freeze(tags) });
      const before = JSON.stringify(record);
      expect(skillReviewDigest(record)).toBe(skillReviewDigest(record));
      expect(JSON.stringify(record)).toBe(before);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("review decisions keep terminal, stale, and context candidates out of mutation", () => {
  const current = { status: "proposed", pattern_kind: "success_pattern", review_digest: "fresh" };
  expect(
    decideCandidateReview(current, { kind: "approve", expected_review_digest: "old" }),
  ).toEqual({ kind: "changed_since_review" });
  expect(
    decideCandidateReview(current, { kind: "approve", expected_review_digest: "fresh" }),
  ).toEqual({ kind: "approve" });
  expect(decideCandidateReview(current, { kind: "approve" })).toEqual({ kind: "approve" });
  expect(decideCandidateReview(current, { kind: "reject", expected_review_digest: "old" })).toEqual(
    { kind: "reject" },
  );
  expect(decideCandidateReview({ ...current, status: "approved" }, { kind: "reject" })).toEqual({
    kind: "already_decided",
  });
  expect(decideCandidateReview({ ...current, status: "context" }, { kind: "reject" })).toEqual({
    kind: "not_found",
  });
});

test("learning and absent candidates remain outside skill approval", () => {
  expect(approvalFailureOf(null)).toBe("not_found");
  for (const pattern_kind of ["session_learning", "knowledge_learning"]) {
    const current = { status: "proposed", pattern_kind, review_digest: "fresh" };
    expect(approvalFailureOf(current)).toBe("not_found");
    expect(decideCandidateReview(current, { kind: "approve" })).toEqual({ kind: "not_found" });
  }
  expect(approvalFailureOf({ status: "proposed", pattern_kind: "repair_pattern" })).toBe(
    "changed_since_review",
  );
  expect(approvalFailureOf({ status: "approved", pattern_kind: "repair_pattern" })).toBe(
    "already_decided",
  );
});
