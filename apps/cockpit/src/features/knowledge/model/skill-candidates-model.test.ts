import { describe, expect, test } from "bun:test";
import type { SkillCandidate } from "@/api/decisions";
import {
  approvalSummary,
  candidateExcerpt,
  candidateRows,
  type DecidedCandidate,
  rejectionSummary,
  selectableCandidate,
  withDecisions,
} from "@/features/knowledge/model/skill-candidates-model";

function candidate(id: string, created_at: string, extra: Partial<SkillCandidate> = {}) {
  return {
    id,
    title: `Rule ${id}`,
    body: `Body of ${id}`,
    created_at,
    reviewable: true,
    review_digest: "d".repeat(64),
    ...extra,
  } as SkillCandidate;
}

describe("skill candidate rows", () => {
  test("a decided candidate stays in the list with its new status after it leaves the queue", () => {
    const first = candidate("a", "2026-01-02T00:00:00Z");
    const second = candidate("b", "2026-01-01T00:00:00Z");
    const decided = new Map<string, DecidedCandidate>([
      ["a", { candidate: first, status: "approved" }],
    ]);
    const rows = candidateRows([second], decided);
    expect(rows.map((row) => [row.candidate.id, row.status])).toEqual([
      ["a", "approved"],
      ["b", "proposed"],
    ]);
  });

  test("only open, reviewable and pinned candidates can be selected", () => {
    const open = candidate("a", "2026-01-01T00:00:00Z");
    expect(selectableCandidate({ candidate: open, status: "proposed" })).toBe(true);
    expect(selectableCandidate({ candidate: open, status: "approved" })).toBe(false);
    expect(selectableCandidate({ candidate: open, status: "rejected" })).toBe(false);
    expect(
      selectableCandidate({ candidate: { ...open, reviewable: false }, status: "proposed" }),
    ).toBe(false);
    expect(
      selectableCandidate({ candidate: { ...open, review_digest: "" }, status: "proposed" }),
    ).toBe(false);
  });

  test("counts only real approvals and keeps the rest apart", () => {
    const summary = approvalSummary([
      { id: "a", outcome: "approved", skill_id: "s" },
      { id: "b", outcome: "changed_since_review", skill_id: null },
      { id: "c", outcome: "already_decided", skill_id: null },
    ]);
    expect(summary).toEqual({ decision: "approved", decided: ["a"], skipped: 2 });
    expect(
      rejectionSummary([
        { id: "a", rejected: true },
        { id: "b", rejected: false },
      ]),
    ).toEqual({ decision: "rejected", decided: ["a"], skipped: 1 });
  });

  test("records the decision only for the candidates that were decided", () => {
    const rows = [
      { candidate: candidate("a", "2026-01-01T00:00:00Z"), status: "proposed" as const },
      { candidate: candidate("b", "2026-01-01T00:00:00Z"), status: "proposed" as const },
    ];
    const next = withDecisions(new Map(), rows, {
      decision: "rejected",
      decided: ["b"],
      skipped: 1,
    });
    expect([...next.keys()]).toEqual(["b"]);
    expect(next.get("b")?.status).toBe("rejected");
  });

  test("the excerpt drops the repeated title and markup and stops at a word", () => {
    expect(
      candidateExcerpt({ title: "Rule", body: "# Rule\n\nUse **short** lines.\n\n- one" }),
    ).toBe("Use short lines. - one");
    const long = candidateExcerpt({ title: "Rule", body: "word ".repeat(80) }, 20);
    expect(long).toBe("word word word word…");
  });
});
