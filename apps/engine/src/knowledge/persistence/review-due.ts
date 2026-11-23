import { and, eq, isNull, lte } from "drizzle-orm";
import { type Executor, knowledgeSources } from "../../db/index.ts";
import type { ReviewDateFacts } from "../core/review-due.ts";

export async function knowledgeSourcesReviewDueBy(
  db: Executor,
  tenant_id: string,
  now: Date,
): Promise<ReviewDateFacts[]> {
  return await db
    .select({
      id: knowledgeSources.id,
      name: knowledgeSources.name,
      status: knowledgeSources.status,
      review_due_at: knowledgeSources.review_due_at,
      deleted_at: knowledgeSources.deleted_at,
    })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        isNull(knowledgeSources.deleted_at),
        lte(knowledgeSources.review_due_at, now),
      ),
    );
}
