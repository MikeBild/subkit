import type { PatchCandidate, SkillCandidate } from "@/api/decisions";
import type { Translate } from "@/lib/i18n";
import { type NameIndex, skillTargetName } from "@/lib/name-index";
import { patchTitle } from "./decision-facts";
import { driftKindKey, fixerKey, proposalKindKey } from "./decisions-context";
import {
  type DecidableItem,
  decisionKey,
  isDecidable,
  patchChangeKind,
  patchDecision,
  skillDecision,
} from "./decisions-model";

export function heldForWorkflow<T extends { workflow_id?: string | null }>(
  held: readonly T[],
  workflowId: string,
): T[] {
  return held.filter((entry) => entry.workflow_id === workflowId);
}

export function reviewDecisionItems(
  candidates: { patches: readonly PatchCandidate[]; skills: readonly SkillCandidate[] },
  names: NameIndex,
  t: Translate,
): DecidableItem[] {
  const items = [
    ...candidates.patches.map((candidate) => {
      const kinds = patchChangeKind(candidate);
      const changeKey =
        fixerKey(kinds.fixer) ??
        proposalKindKey(kinds.proposalKind) ??
        driftKindKey(kinds.driftKind);
      const title = patchTitle({
        workflow: candidate.workflow_name ?? null,
        change: changeKey ? t(changeKey) : null,
      });
      return patchDecision(candidate, t(title.key, title.params));
    }),
    ...candidates.skills.map((candidate) =>
      skillDecision(candidate, skillTargetName(names, candidate)),
    ),
  ];
  return [...new Map(items.map((item) => [decisionKey(item), item])).values()].filter(
    isDecidable,
  ) as DecidableItem[];
}
