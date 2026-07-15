// Pending session-learning count for the `sk` REPL start screen.
//
// The skill-candidates subsystem proposes session learnings from
// conversation patterns; they become Skills only through explicit
// operator approval. At REPL open we count the proposed ones so the
// welcome row can inject a "Review N proposed learning(s)" starter
// action. Best-effort: any failure here must never block or delay the
// REPL — mirror of the operator-digest fetch contract.

import type { EngineClient } from "../engine-client.ts";

export async function fetchPendingLearningsCount(client: EngineClient): Promise<number> {
  try {
    const res = await client.listSkillCandidates({
      status: "proposed",
      pattern_kind: "session_learning",
      limit: 100,
    });
    return res.items.length;
  } catch {
    return 0;
  }
}
