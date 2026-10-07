import type { EngineClient } from "../engine-client.ts";

const LEARNING_KINDS = ["session_learning", "knowledge_learning"] as const;

const REVIEW_PAGE_SIZE = 100;

export interface LearningCandidate {
  id: string;
  pattern_kind: (typeof LEARNING_KINDS)[number];
  title: string;
  body: string;
  pitfalls?: string[];
  tags?: string[];
  confidence: string;
  evidence_count: number;
  created_at: string;
}

export function learningTarget(
  candidate: Pick<LearningCandidate, "pattern_kind" | "tags">,
): string {
  if (candidate.pattern_kind !== "knowledge_learning") return "skill";
  const domain = (candidate.tags ?? [])
    .find((tag) => tag.startsWith("domain:") && tag.length > "domain:".length)
    ?.slice("domain:".length);
  return `knowledge: ${domain ? `learnings-${domain}` : "learnings"}`;
}

async function fetchKind(
  client: EngineClient,
  pattern_kind: LearningCandidate["pattern_kind"],
): Promise<LearningCandidate[]> {
  const out: LearningCandidate[] = [];
  let fetched = 0;
  for (;;) {
    const res = await client.listSkillCandidates({
      status: "proposed",
      pattern_kind,
      limit: REVIEW_PAGE_SIZE,
      offset: fetched,
    });
    const items = res.items as unknown as LearningCandidate[];
    fetched += items.length;
    out.push(...items);
    if (items.length === 0 || fetched >= res.total) return out;
  }
}

export async function fetchProposedLearnings(client: EngineClient): Promise<LearningCandidate[]> {
  const seen = new Set<string>();
  const out: LearningCandidate[] = [];
  for (const kind of LEARNING_KINDS) {
    for (const item of await fetchKind(client, kind)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export async function fetchPendingLearningsCount(client: EngineClient): Promise<number> {
  try {
    const counts = await Promise.all(
      LEARNING_KINDS.map((pattern_kind) =>
        client.listSkillCandidates({ status: "proposed", pattern_kind, limit: 1 }),
      ),
    );
    return counts.reduce((sum, res) => sum + res.total, 0);
  } catch {
    return 0;
  }
}
