import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import {
  type HeldSchedule,
  listAwaitingConversations,
  listFailingWorkflows,
  listHeldSchedules,
  listProposedPatchCandidates,
  listProposedSkillCandidates,
} from "@/api/decisions";
import { type QueryView, queryView } from "@/components/failure-state";
import { type FailingWorkflow, failingWorkflows } from "@/lib/failing-workflows";
import { useI18n } from "@/lib/i18n-context";
import type { NameIndex } from "@/lib/name-index";
import {
  buildNameIndex,
  EMPTY_NAME_INDEX,
  type NamedEntity,
  resolveTargetName,
  skillTargetName,
} from "@/lib/name-index";
import { driftKindKey, proposalKindKey } from "@/pages/decisions-context";
import {
  badgeCount,
  conversationDecision,
  type DecisionItem,
  decisionKey,
  hasOverdue,
  isDecidable,
  type OpenDecisions,
  openDecisionQueue,
  patchChangeKind,
  patchDecision,
  patchTitle,
  type QueueChip,
  queueChips,
  type SourceState,
  skillDecision,
} from "@/pages/decisions-model";

export interface DecisionSources {
  patches: boolean;
  skills: boolean;
  conversations: boolean;
  /** Reading the operator digest, which is where failing runs are grouped. */
  failing: boolean;
}

export interface DecisionQueue {
  /**
   * The waiting conversations, counted apart from the badge: they are answered
   * in the chat, not decided here. `total` is the engine's own count. `null`
   * when this person may not list conversations.
   */
  questions: { view: QueryView; total: number | null } | null;
  heldSchedules: HeldSchedule[];
  /** Approved, scheduled, and failing — the opposite of a held schedule. */
  failingWorkflows: FailingWorkflow[];
  items: DecisionItem[];
  /** Resolves the ids a decision carries to names, so the context columns can
   *  say which workflow rather than "Workflow". */
  names: NameIndex;
  /** Whether this person may open a run. Decides whether the failing-run link
   *  appears at all — the permission is evaluated per object. */
  canReadRuns: boolean;
  /** The one count: total, per-source breakdown, subsets and oldest age.
   *  Null while it cannot be read — an omitted number beats a guessed one. */
  open: OpenDecisions | null;
  /** The kind chips this person can read, with their numbers (decisions-model `queueChips`). */
  chips: QueueChip[] | null;
  /** The navigation badge: the sum of the chip numbers, or null when there is none to show. */
  badge: number | null;
  /**
   * Whether the digest behind the failing workflows answered. It used to be
   * caught as an empty list, so a digest that failed read as "nothing is
   * failing" on the chip, the badge and the section alike.
   */
  failingSource: SourceState;
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
    failing: allowed.has("stats:read"),
  };
}

export function canSeeDecisions(permissions: readonly string[]): boolean {
  const sources = decisionSources(permissions);
  return sources.patches || sources.skills || sources.conversations;
}

/**
 * One query behind both the navigation counter and the decisions page, so the
 * badge can never disagree with the queue it links to.
 *
 * Why not the overview's decision tiles: `GET /v1/operational-overview` needs
 * `stats:read`, which a reviewer holding only `workflow:read`/`skill:read` does
 * not have, and it partitions by bucket (blocked/failing/overdue/other), not by
 * the kinds the chips filter on. The numbers are the same predicates instead:
 * the patch chip is `reviewable_total` (the engine's `readOpenPatchDecisions`),
 * the skill chip `reviewable_total` (proposed, not failure/authoring pattern),
 * held schedules are `/v1/schedules` with `admission_hold` (null for paused or
 * archived workflows), failing ones the digest's groups filtered as
 * `failingScheduledGroups` over the same 168-hour window.
 */
export function useDecisionQueue(permissions: readonly string[]): DecisionQueue {
  const { t } = useI18n();
  const sources = decisionSources(permissions);
  // Two of the three sources name their target with an id only. The catalogue
  // is small and already cached elsewhere, so one fetch each turns those ids
  // into names — and a target that stays unresolved renders as nothing rather
  // than as a UUID.
  const names = useQuery({
    queryKey: ["decisions", "names", sources.skills, sources.conversations],
    enabled: sources.skills || sources.conversations,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [workflows, connectors] = await Promise.all([
        permissions.includes("workflow:read")
          ? apiRequest<{ items: NamedEntity[] }>("/v1/workflows?limit=200")
          : null,
        permissions.includes("connector:read")
          ? apiRequest<{ items: NamedEntity[] }>("/v1/connectors?limit=200")
          : null,
      ]);
      return buildNameIndex(workflows?.items ?? [], connectors?.items ?? []);
    },
  });
  const nameIndex = names.data ?? EMPTY_NAME_INDEX;
  const query = useQuery({
    queryKey: [
      "decisions",
      "queue",
      sources.patches,
      sources.skills,
      sources.conversations,
      names.dataUpdatedAt,
    ],
    enabled: sources.patches || sources.skills || sources.conversations,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const [patches, skills, conversations, heldSchedules, failureGroups] = await Promise.all([
        sources.patches ? listProposedPatchCandidates() : null,
        sources.skills ? listProposedSkillCandidates() : null,
        sources.conversations ? listAwaitingConversations() : null,
        sources.patches ? listHeldSchedules() : [],
        // A digest that cannot be read is not a reason to lose the rest of the
        // queue: this section simply stays empty.
        // `null` is "asked and failed" — never an empty list.
        sources.failing ? listFailingWorkflows().catch(() => null) : [],
      ]);
      const items: DecisionItem[] = [
        ...(patches?.items ?? []).map((candidate) => {
          // The engine passes the repair model's English change note straight
          // through. It stays as the card's summary; the title is the German
          // line derived from what the decision is about (§5).
          const kinds = patchChangeKind(candidate);
          const changeKey = proposalKindKey(kinds.proposalKind) ?? driftKindKey(kinds.driftKind);
          const title = patchTitle({
            workflow: candidate.workflow_name ?? null,
            change: changeKey ? t(changeKey) : null,
          });
          return patchDecision(candidate, t(title.key, title.params));
        }),
        ...(skills?.items ?? []).map((candidate) =>
          skillDecision(candidate, skillTargetName(nameIndex, candidate)),
        ),
        ...(conversations?.items ?? []).map((conversation) =>
          conversationDecision(
            conversation,
            {
              fallbackTitle: t("decisions.fallbackTitle.conversation"),
              toolActivity: t("chat.toolActivity"),
              hiddenReference: t("tool.referenceHiddenInline"),
            },
            resolveTargetName(nameIndex, "workflow", conversation.target_workflow_id),
          ),
        ),
      ];
      return {
        heldSchedules,
        failingWorkflows: failingWorkflows(failureGroups ?? []),
        failingSource: (!sources.failing
          ? "not_permitted"
          : failureGroups === null
            ? "failed"
            : "answered") as SourceState,
        // Deduplicated here, not at the card: two sources may hand out the same
        // row, and one position is one decision on every surface that shows it.
        items: [...new Map(items.map((item) => [decisionKey(item), item])).values()],
        totals: {
          patch: patches?.reviewable_total ?? 0,
          skill: skills?.reviewable_total ?? 0,
          conversation: conversations?.total ?? 0,
        },
      };
    },
  });

  const items = query.data?.items ?? [];
  const now = Date.now();
  const heldSchedules = query.data?.heldSchedules ?? [];
  const failing = query.data?.failingWorkflows ?? [];
  // One rule, in the model: the badge counts what the chips count.
  const open = query.data
    ? openDecisionQueue({
        items,
        totals: query.data.totals,
        held: heldSchedules.length,
        failing: failing.length,
        nowMs: now,
      })
    : null;
  const failingSource: SourceState =
    query.data?.failingSource ?? (sources.failing ? "answered" : "not_permitted");
  const chips = queueChips({
    open,
    readable: { patches: sources.patches, skills: sources.skills, failing: sources.failing },
    held: heldSchedules.length,
    failing: { state: failingSource, count: failing.length },
  });
  return {
    // Without the permission there is no answer at all — not "nobody is
    // waiting", which is a claim this person has no way to check.
    questions: sources.conversations
      ? {
          view: queryView(
            query,
            (data) => !data.items.some((item) => item.kind === "conversation"),
          ),
          total: query.data?.totals.conversation ?? null,
        }
      : null,
    heldSchedules,
    failingWorkflows: failing,
    items,
    names: nameIndex,
    canReadRuns: permissions.includes("execution:read"),
    open,
    chips,
    badge: badgeCount(chips),
    failingSource,
    overdue: hasOverdue(items.filter(isDecidable), now),
    isPending: query.isPending,
    isFetching: query.isFetching,
    // React Query keeps retrying before `error` becomes final. Showing the
    // failure during that interval prevents a blank loading loop and gives the
    // operator an immediate, explicit recovery action.
    failed: Boolean(query.error ?? query.failureReason),
    sources,
    refetch: () => void query.refetch(),
  };
}
