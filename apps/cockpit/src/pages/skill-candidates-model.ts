import type { SkillCandidate, SkillCandidateApproval } from "@/api/decisions";
import { documentUnderTitle } from "@/pages/knowledge-sources-model";

export type CandidateDecision = "approved" | "rejected";

export type CandidateRowStatus = "proposed" | CandidateDecision;

export interface DecidedCandidate {
  candidate: SkillCandidate;
  status: CandidateDecision;
}

export interface CandidateRow {
  candidate: SkillCandidate;
  status: CandidateRowStatus;
}

export const EXCERPT_LENGTH = 180;

export function candidateExcerpt(
  candidate: Pick<SkillCandidate, "title" | "body">,
  length = EXCERPT_LENGTH,
): string {
  const text = documentUnderTitle(candidate.body, candidate.title)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length).replace(/\s+\S*$/, "")}…`;
}

export function candidateRows(
  open: readonly SkillCandidate[],
  decided: ReadonlyMap<string, DecidedCandidate>,
): CandidateRow[] {
  const rows: CandidateRow[] = open.map((candidate) => ({
    candidate,
    status: decided.get(candidate.id)?.status ?? "proposed",
  }));
  const shown = new Set(open.map((candidate) => candidate.id));
  for (const entry of decided.values())
    if (!shown.has(entry.candidate.id))
      rows.push({ candidate: entry.candidate, status: entry.status });
  return rows.sort((a, b) => b.candidate.created_at.localeCompare(a.candidate.created_at));
}

export function selectableCandidate(row: CandidateRow): boolean {
  return (
    row.status === "proposed" &&
    row.candidate.reviewable === true &&
    Boolean(row.candidate.review_digest)
  );
}

export interface DecisionSummary {
  decision: CandidateDecision;
  decided: string[];
  skipped: number;
}

export function approvalSummary(results: readonly SkillCandidateApproval[]): DecisionSummary {
  const decided = results.filter((result) => result.outcome === "approved").map((r) => r.id);
  return { decision: "approved", decided, skipped: results.length - decided.length };
}

export function rejectionSummary(
  outcomes: readonly { id: string; rejected: boolean }[],
): DecisionSummary {
  const decided = outcomes.filter((outcome) => outcome.rejected).map((outcome) => outcome.id);
  return { decision: "rejected", decided, skipped: outcomes.length - decided.length };
}

export function withDecisions(
  decided: ReadonlyMap<string, DecidedCandidate>,
  rows: readonly CandidateRow[],
  summary: DecisionSummary,
): Map<string, DecidedCandidate> {
  const next = new Map(decided);
  const byId = new Map(rows.map((row) => [row.candidate.id, row.candidate]));
  for (const id of summary.decided) {
    const candidate = byId.get(id);
    if (candidate) next.set(id, { candidate, status: summary.decision });
  }
  return next;
}
