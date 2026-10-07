import type { SkillCandidate } from "@/api/decisions";
import type { TranslationKey } from "@/lib/i18n";
import type { FocusedRow } from "@/lib/line-diff";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type Proposal = Pick<SkillCandidate, "pattern_kind" | "tags">;

const DOMAIN_TAG = "domain:";

export function isKnowledgeFact(candidate: Pick<SkillCandidate, "pattern_kind">): boolean {
  return candidate.pattern_kind === "knowledge_learning";
}

export function proposalDomain(candidate: Proposal): string | null {
  const tag = (candidate.tags ?? []).find(
    (t) => t.startsWith(DOMAIN_TAG) && t.length > DOMAIN_TAG.length,
  );
  return tag ? tag.slice(DOMAIN_TAG.length) : null;
}

export function proposalTarget(candidate: Proposal, t: Translate): string {
  if (!isKnowledgeFact(candidate)) return t("proposal.target.skill");
  const domain = proposalDomain(candidate);
  return domain ? t("proposal.target.knowledge", { domain }) : t("proposal.target.knowledgeShared");
}

export function proposalAuthor(
  candidate: Pick<SkillCandidate, "proposed_by">,
  directory: ReadonlyMap<string, string>,
  t: Translate,
): string | null {
  const by = candidate.proposed_by;
  if (!by) return null;
  return (
    directory.get(by.id) ?? t(by.kind === "user" ? "audit.actor.user" : "audit.actor.systemAccount")
  );
}

export function proposalAddition(candidate: Pick<SkillCandidate, "title" | "body">): FocusedRow[] {
  const section = `## ${candidate.title.trim()}\n\n${candidate.body.trim()}`;
  return section.split("\n").map((text) => ({ type: "added" as const, text }));
}

export function approvalActivatesSkill(candidate: Pick<SkillCandidate, "pattern_kind">): boolean {
  return !isKnowledgeFact(candidate);
}
