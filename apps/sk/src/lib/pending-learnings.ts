// Proposed session-learning queries, shared by the REPL start screen and
// `sk learnings`. The skill-candidates subsystem proposes session learnings
// from conversation patterns; they become Skills only through explicit
// operator approval. This module owns the one canonical filter (status +
// pattern_kind) so the welcome-row count and the review queue can never
// silently diverge.

import type { EngineClient } from "../engine-client.ts";

/** The one canonical "review queue" filter. */
const PROPOSED_LEARNINGS_QUERY = {
  status: "proposed",
  pattern_kind: "session_learning",
} as const;

const REVIEW_QUEUE_LIMIT = 100;

export interface LearningCandidate {
  id: string;
  title: string;
  body: string;
  pitfalls?: string[];
  tags?: string[];
  confidence: string;
  evidence_count: number;
  created_at: string;
}

/** Full review queue for `sk learnings list/review`. */
export async function fetchProposedLearnings(client: EngineClient): Promise<LearningCandidate[]> {
  const { items } = await client.listSkillCandidates({
    ...PROPOSED_LEARNINGS_QUERY,
    limit: REVIEW_QUEUE_LIMIT,
  });
  return items as unknown as LearningCandidate[];
}

/**
 * True pending count for the REPL start screen. Uses the server-computed
 * `total` (limit: 1 keeps the payload to one row) so the count is honest
 * beyond any page cap. Best-effort: any failure here must never block or
 * delay the REPL — mirror of the operator-digest fetch contract.
 */
export async function fetchPendingLearningsCount(client: EngineClient): Promise<number> {
  try {
    const res = await client.listSkillCandidates({ ...PROPOSED_LEARNINGS_QUERY, limit: 1 });
    return res.total;
  } catch {
    return 0;
  }
}
