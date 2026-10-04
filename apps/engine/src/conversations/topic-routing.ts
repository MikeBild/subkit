import { and, desc, eq } from "drizzle-orm";
import { type Executor, getDb } from "../db/client.ts";
import { conversations } from "../db/schema/conversations.ts";
import { vectorScoreCandidates } from "../embeddings/vector-rerank.ts";

export const TOPIC_MIN_COSINE = 0.425;

const CANDIDATE_SCAN = 30;

export interface ConversationSuggestion {
  conversation_id: string;
  title: string | null;
  cosine: number;
}

export async function suggestConversationsByTopic(
  p: { tenant_id: string; owner_id: string; message: string; limit?: number },
  exec?: Executor,
): Promise<ConversationSuggestion[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 3), 10);
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      embedding: conversations.topic_embedding,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, p.tenant_id),
        eq(conversations.owner_id, p.owner_id),
        eq(conversations.status, "active"),
      ),
    )
    .orderBy(desc(conversations.updated_at))
    .limit(CANDIDATE_SCAN);

  const scored = await vectorScoreCandidates(
    p.message,
    rows.map((r) => ({ item: r, embedding: r.embedding })),
    { minCosine: TOPIC_MIN_COSINE },
  );
  return scored.slice(0, limit).map((s) => ({
    conversation_id: s.item.id,
    title: s.item.title,
    cosine: s.cosine,
  }));
}
