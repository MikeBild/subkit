export const KNOWLEDGE_REVIEW_LIST_LIMIT = 10;

export interface ReviewDateFacts {
  id: string;
  name: string;
  status: string;
  review_due_at: Date | null;
  deleted_at: Date | null;
}

export interface DueKnowledgeReviews {
  count: number;
  oldest_due_at: string | null;
  sources: Array<{ id: string; name: string; review_due_at: string }>;
}

export function isReviewDue(facts: ReviewDateFacts, now: Date): boolean {
  return (
    facts.deleted_at === null &&
    facts.status !== "inactive" &&
    facts.review_due_at !== null &&
    facts.review_due_at.getTime() <= now.getTime()
  );
}

export function dueKnowledgeReviews(
  rows: readonly ReviewDateFacts[],
  now: Date,
  limit = KNOWLEDGE_REVIEW_LIST_LIMIT,
): DueKnowledgeReviews {
  const due = rows
    .filter((row) => isReviewDue(row, now))
    .map((row) => ({ id: row.id, name: row.name, at: row.review_due_at as Date }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    count: due.length,
    oldest_due_at: due[0]?.at.toISOString() ?? null,
    sources: due
      .slice(0, limit)
      .map((row) => ({ id: row.id, name: row.name, review_due_at: row.at.toISOString() })),
  };
}
