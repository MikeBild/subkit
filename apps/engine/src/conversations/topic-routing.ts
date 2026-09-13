// Topic-based conversation routing — suggest prior conversations by topic.
//
// On a new prompt, find the caller's prior conversations whose topic (their
// first user message) is semantically close, so the LLM / sk can offer
// "continue ‹topic X›?" and resume via the existing conversation_append.
// This SUGGESTS — it never auto-resumes: a wrong suggestion costs one "no",
// a wrong auto-resume silently injects an entire unrelated context.
//
// Measured (benchmarks/routing/conversation-route-probe.ts): at τ* = 0.425,
// top-1 89%, correct-abstain 100%, recall@3 100%, near-miss 100% — the model
// separates same-vendor siblings (refund vs payout) and routes across EN/DE.
// The threshold below the recall floor would false-route; above it drops
// legitimate matches. Reuses the local embedding provider — no pgvector: the
// cosine runs in JS over the caller's bounded, owner-scoped candidate set.

import { and, desc, eq } from "drizzle-orm";

import { type Executor, getDb } from "../db/client.ts";
import { conversations } from "../db/schema/conversations.ts";
import { vectorScoreCandidates } from "../embeddings/vector-rerank.ts";

/** Operating point from the routing probe: τ* = argmax min(top1, abstain). */
export const TOPIC_MIN_COSINE = 0.425;

/** How many recent owner conversations to score. Bounded so the cosine pass
 *  stays cheap; recency-ordered so stale conversations fall off naturally. */
const CANDIDATE_SCAN = 30;

export interface ConversationSuggestion {
  conversation_id: string;
  title: string | null;
  cosine: number;
}

/**
 * Suggest the caller's prior conversations most related to `message`, ranked
 * by topic cosine and floored at TOPIC_MIN_COSINE. Returns `[]` when nothing
 * clears the floor (the prompt is a new topic → start fresh) or when
 * embeddings are unavailable. Scoped to tenant + owner so it can only ever
 * surface the caller's own conversations.
 */
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
