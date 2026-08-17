import { useQuery } from "@tanstack/react-query";
import {
  listAwaitingConversations,
  listProposedPatchCandidates,
  listProposedSkillCandidates,
} from "@/api/decisions";
import { useI18n } from "@/lib/i18n-context";
import {
  conversationDecision,
  type DecisionItem,
  hasOverdue,
  patchDecision,
  skillDecision,
} from "@/pages/decisions-model";

export interface DecisionSources {
  patches: boolean;
  skills: boolean;
  conversations: boolean;
}

export interface DecisionQueue {
  items: DecisionItem[];
  /** Exact open count from the engine totals, or null while unknown. */
  total: number | null;
  overdue: boolean;
  isPending: boolean;
  isFetching: boolean;
  failed: boolean;
  sources: DecisionSources;
  refetch: () => void;
}

export function decisionSources(permissions: readonly string[]): DecisionSources {
  const allowed = new Set(permissions);
  return {
    patches: allowed.has("workflow:read"),
    skills: allowed.has("skill:read"),
    conversations: allowed.has("conversation:list") || allowed.has("conversation:read"),
  };
}

export function canSeeDecisions(permissions: readonly string[]): boolean {
  const sources = decisionSources(permissions);
  return sources.patches || sources.skills || sources.conversations;
}

/**
 * One query behind both the navigation counter and the decisions page, so the
 * badge can never disagree with the queue it links to.
 */
export function useDecisionQueue(permissions: readonly string[]): DecisionQueue {
  const { t } = useI18n();
  const sources = decisionSources(permissions);
  const query = useQuery({
    queryKey: ["decisions", "queue", sources.patches, sources.skills, sources.conversations],
    enabled: sources.patches || sources.skills || sources.conversations,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const [patches, skills, conversations] = await Promise.all([
        sources.patches ? listProposedPatchCandidates() : null,
        sources.skills ? listProposedSkillCandidates() : null,
        sources.conversations ? listAwaitingConversations() : null,
      ]);
      const items: DecisionItem[] = [
        ...(patches?.items ?? []).map((candidate) =>
          patchDecision(candidate, t("decisions.fallbackTitle.patch")),
        ),
        ...(skills?.items ?? []).map(skillDecision),
        ...(conversations?.items ?? []).map((conversation) =>
          conversationDecision(conversation, {
            fallbackTitle: t("decisions.fallbackTitle.conversation"),
            toolActivity: t("chat.toolActivity"),
            hiddenReference: t("tool.referenceHiddenInline"),
          }),
        ),
      ];
      const total = (patches?.total ?? 0) + (skills?.total ?? 0) + (conversations?.total ?? 0);
      return { items, total };
    },
  });

  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? null,
    overdue: hasOverdue(query.data?.items ?? [], Date.now()),
    isPending: query.isPending,
    isFetching: query.isFetching,
    failed: Boolean(query.error),
    sources,
    refetch: () => void query.refetch(),
  };
}
