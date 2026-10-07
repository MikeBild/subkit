import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import {
  fetchPendingLearningsCount,
  fetchProposedLearnings,
  learningTarget,
} from "../lib/pending-learnings.ts";

function candidate(id: string, pattern_kind: string, created_at: string) {
  return {
    id,
    pattern_kind,
    title: id,
    body: "b",
    confidence: "high",
    evidence_count: 1,
    created_at,
  };
}

function fakeClient(byKind: Record<string, ReturnType<typeof candidate>[]>): EngineClient {
  return {
    listSkillCandidates: async (query: {
      pattern_kind: string;
      limit: number;
      offset?: number;
    }) => {
      const all = byKind[query.pattern_kind] ?? [];
      const offset = query.offset ?? 0;
      return { items: all.slice(offset, offset + query.limit), total: all.length };
    },
  } as unknown as EngineClient;
}

describe("pending learnings", () => {
  test("a fact names the knowledge source it lands in, a practice the skill", () => {
    expect(learningTarget({ pattern_kind: "knowledge_learning", tags: ["domain:ops"] })).toBe(
      "knowledge: learnings-ops",
    );
    expect(learningTarget({ pattern_kind: "knowledge_learning", tags: [] })).toBe(
      "knowledge: learnings",
    );
    expect(learningTarget({ pattern_kind: "session_learning", tags: ["domain:ops"] })).toBe(
      "skill",
    );
  });

  test("review lists practices and facts together, oldest first", async () => {
    const client = fakeClient({
      session_learning: [candidate("p", "session_learning", "2026-01-02T00:00:00.000Z")],
      knowledge_learning: [candidate("f", "knowledge_learning", "2026-01-01T00:00:00.000Z")],
    });
    expect((await fetchProposedLearnings(client)).map((c) => c.id)).toEqual(["f", "p"]);
    expect(await fetchPendingLearningsCount(client)).toBe(2);
  });
});
