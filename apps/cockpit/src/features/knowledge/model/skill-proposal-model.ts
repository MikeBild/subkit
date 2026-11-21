import type { SkillCandidate } from "@/api/decisions";

const COLLECTED_KINDS: ReadonlySet<string> = new Set(["session_learning", "knowledge_learning"]);

export function isDetectedPattern(candidate: Pick<SkillCandidate, "pattern_kind">): boolean {
  return !COLLECTED_KINDS.has(candidate.pattern_kind ?? "");
}

export function mayApproveProposal(permissions: readonly string[]): boolean {
  return permissions.includes("skill:write") && permissions.includes("skill:activate");
}
