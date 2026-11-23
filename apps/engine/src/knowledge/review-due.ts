import type { Executor } from "../db/index.ts";
import { type DueKnowledgeReviews, dueKnowledgeReviews } from "./core/review-due.ts";
import { knowledgeSourcesReviewDueBy } from "./persistence/review-due.ts";

export type { DueKnowledgeReviews } from "./core/review-due.ts";

export async function listDueKnowledgeReviews(
  db: Executor,
  tenant_id: string,
  now: Date,
): Promise<DueKnowledgeReviews> {
  return dueKnowledgeReviews(await knowledgeSourcesReviewDueBy(db, tenant_id, now), now);
}
