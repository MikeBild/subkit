import { describe, expect, test } from "bun:test";
import { dueKnowledgeReviews, isReviewDue, type ReviewDateFacts } from "./review-due.ts";

const now = new Date("2026-11-23T12:00:00.000Z");

function facts(overrides: Partial<ReviewDateFacts> = {}): ReviewDateFacts {
  return {
    id: "a",
    name: "Runbook",
    status: "active",
    review_due_at: new Date("2026-11-20T00:00:00.000Z"),
    deleted_at: null,
    ...overrides,
  };
}

describe("isReviewDue", () => {
  test("is due on and after the review date", () => {
    expect(isReviewDue(facts(), now)).toBe(true);
    expect(isReviewDue(facts({ review_due_at: now }), now)).toBe(true);
  });

  test("is not due before the date, without a date, when inactive or deleted", () => {
    expect(isReviewDue(facts({ review_due_at: new Date("2026-11-24T00:00:00.000Z") }), now)).toBe(
      false,
    );
    expect(isReviewDue(facts({ review_due_at: null }), now)).toBe(false);
    expect(isReviewDue(facts({ status: "inactive" }), now)).toBe(false);
    expect(isReviewDue(facts({ deleted_at: now }), now)).toBe(false);
  });

  test("a source that is processing or failing still needs its review", () => {
    expect(isReviewDue(facts({ status: "error" }), now)).toBe(true);
  });
});

describe("dueKnowledgeReviews", () => {
  test("lists due sources oldest first, capped, with the full count", () => {
    const rows = [
      facts({ id: "c", name: "C", review_due_at: new Date("2026-11-22T00:00:00.000Z") }),
      facts({ id: "b", name: "B", review_due_at: new Date("2026-11-01T00:00:00.000Z") }),
      facts({ id: "a", name: "A", review_due_at: new Date("2026-11-01T00:00:00.000Z") }),
      facts({ id: "later", review_due_at: new Date("2026-12-01T00:00:00.000Z") }),
    ];
    expect(dueKnowledgeReviews(rows, now, 2)).toEqual({
      count: 3,
      oldest_due_at: "2026-11-01T00:00:00.000Z",
      sources: [
        { id: "a", name: "A", review_due_at: "2026-11-01T00:00:00.000Z" },
        { id: "b", name: "B", review_due_at: "2026-11-01T00:00:00.000Z" },
      ],
    });
  });

  test("is empty when nothing is due", () => {
    expect(dueKnowledgeReviews([facts({ review_due_at: null })], now)).toEqual({
      count: 0,
      oldest_due_at: null,
      sources: [],
    });
  });
});
