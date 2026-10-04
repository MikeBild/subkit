import type { EngineClient } from "../engine-client.ts";

const PROPOSED_LEARNINGS_QUERY = {
  status: "proposed",
  pattern_kind: "session_learning",
} as const;

const REVIEW_PAGE_SIZE = 100;

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

export async function fetchProposedLearnings(client: EngineClient): Promise<LearningCandidate[]> {
  const out: LearningCandidate[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  for (;;) {
    const res = await client.listSkillCandidates({
      ...PROPOSED_LEARNINGS_QUERY,
      limit: REVIEW_PAGE_SIZE,
      offset: fetched,
    });
    const items = res.items as unknown as LearningCandidate[];
    fetched += items.length;
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    if (items.length === 0 || fetched >= res.total) return out;
  }
}

export async function fetchPendingLearningsCount(client: EngineClient): Promise<number> {
  try {
    const res = await client.listSkillCandidates({ ...PROPOSED_LEARNINGS_QUERY, limit: 1 });
    return res.total;
  } catch {
    return 0;
  }
}
