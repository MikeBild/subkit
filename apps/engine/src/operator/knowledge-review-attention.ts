import type { DueKnowledgeReviews } from "../knowledge/index.ts";
import type { Candidate } from "./attention-readers.ts";

export const KNOWLEDGE_REVIEW_HREF = {
  source: (id: string) => `/cockpit/knowledge/${encodeURIComponent(id)}`,
  list: "/cockpit/knowledge",
} as const;

export function knowledgeReviewCandidates(due: DueKnowledgeReviews): Candidate[] {
  const [first] = due.sources;
  if (due.count === 0 || !first) return [];
  const single = due.count === 1;
  return [
    {
      source: "knowledge",
      ...(single ? { resource: { type: "knowledge", id: first.id } } : {}),
      item: {
        id: single ? `knowledge_review:${first.id}` : "knowledge_review",
        class: "decide",
        severity: "notice",
        kind: "knowledge_review",
        subject: single ? { kind: "knowledge", id: first.id, name: first.name } : null,
        reason: "knowledge_review_due",
        trigger: null,
        cause_class: null,
        counts: { knowledge_reviews: due.count },
        since: due.oldest_due_at,
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "review",
            href: single ? KNOWLEDGE_REVIEW_HREF.source(first.id) : KNOWLEDGE_REVIEW_HREF.list,
            primary: true,
            permission: "knowledge:read",
          },
        ],
      },
    },
  ];
}
