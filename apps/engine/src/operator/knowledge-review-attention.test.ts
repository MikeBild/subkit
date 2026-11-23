import { describe, expect, test } from "bun:test";
import { knowledgeReviewCandidates } from "./knowledge-review-attention.ts";

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";

describe("knowledge review attention", () => {
  test("nothing due yields no entry", () => {
    expect(knowledgeReviewCandidates({ count: 0, oldest_due_at: null, sources: [] })).toEqual([]);
  });

  test("one due source names it, links to it and is gated on that source", () => {
    const [candidate, ...rest] = knowledgeReviewCandidates({
      count: 1,
      oldest_due_at: "2026-01-02T00:00:00.000Z",
      sources: [{ id: SOURCE_A, name: "Runbook", review_due_at: "2026-01-02T00:00:00.000Z" }],
    });
    expect(rest).toEqual([]);
    expect(candidate?.source).toBe("knowledge");
    expect(candidate?.resource).toEqual({ type: "knowledge", id: SOURCE_A });
    expect(candidate?.item).toMatchObject({
      id: `knowledge_review:${SOURCE_A}`,
      class: "decide",
      reason: "knowledge_review_due",
      subject: { kind: "knowledge", id: SOURCE_A, name: "Runbook" },
      detail: null,
      since: "2026-01-02T00:00:00.000Z",
      counts: { knowledge_reviews: 1 },
      actions: [
        {
          verb: "review",
          href: `/cockpit/knowledge/${SOURCE_A}`,
          primary: true,
          permission: "knowledge:read",
        },
      ],
    });
  });

  test("several due sources collapse into one counted entry that opens the list", () => {
    const [candidate, ...rest] = knowledgeReviewCandidates({
      count: 3,
      oldest_due_at: "2026-01-01T00:00:00.000Z",
      sources: [
        { id: SOURCE_A, name: "Runbook", review_due_at: "2026-01-01T00:00:00.000Z" },
        { id: SOURCE_B, name: "Pricing", review_due_at: "2026-01-03T00:00:00.000Z" },
      ],
    });
    expect(rest).toEqual([]);
    expect(candidate?.resource).toBeUndefined();
    expect(candidate?.item).toMatchObject({
      id: "knowledge_review",
      subject: null,
      detail: null,
      since: "2026-01-01T00:00:00.000Z",
      counts: { knowledge_reviews: 3 },
      actions: [{ href: "/cockpit/knowledge" }],
    });
  });
});
