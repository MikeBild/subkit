import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import {
  type HeldSchedule,
  listHeldSchedules,
  listProposedPatchCandidates,
  listProposedSkillCandidates,
} from "@/api/decisions";
import { useI18n } from "@/lib/i18n-context";
import type { NameIndex } from "@/lib/name-index";
import {
  buildNameIndex,
  EMPTY_NAME_INDEX,
  type NamedEntity,
  skillTargetName,
} from "@/lib/name-index";
import { driftKindKey, proposalKindKey } from "@/pages/decisions-context";
import {
  type DecidableItem,
  decisionKey,
  isDecidable,
  patchChangeKind,
  patchDecision,
  patchTitle,
  skillDecision,
} from "@/pages/decisions-model";
import { type ReviewAccess, type ReviewTarget, reviewAccess } from "@/pages/overview-model";

/**
 * The ids two of the decision sources name their target with, as names. The
 * catalogue is small and cached; a target that stays unresolved renders as
 * nothing rather than as a UUID.
 */
function useNameIndex(permissions: readonly string[], enabled: boolean): NameIndex {
  const canWorkflows = permissions.includes("workflow:read");
  const canConnectors = permissions.includes("connector:read");
  const names = useQuery({
    queryKey: ["decisions", "names", canWorkflows, canConnectors],
    enabled: enabled && (canWorkflows || canConnectors),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [workflows, connectors] = await Promise.all([
        canWorkflows ? apiRequest<{ items: NamedEntity[] }>("/v1/workflows?limit=200") : null,
        canConnectors ? apiRequest<{ items: NamedEntity[] }>("/v1/connectors?limit=200") : null,
      ]);
      return buildNameIndex(workflows?.items ?? [], connectors?.items ?? []);
    },
  });
  return names.data ?? EMPTY_NAME_INDEX;
}

/** Schedules held for an approval — what the chat's hand-off asks about. */
export function useHeldSchedules(permissions: readonly string[]): HeldSchedule[] {
  const query = useQuery({
    queryKey: ["decisions", "held"],
    enabled: permissions.includes("workflow:read"),
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: listHeldSchedules,
  });
  return query.data ?? [];
}

export interface ReviewDecisions {
  access: ReviewAccess;
  isPending: boolean;
  failed: boolean;
  decisions: DecidableItem[];
  held: HeldSchedule[];
  names: NameIndex;
  canReadRuns: boolean;
  refetch: () => void;
}

/**
 * The decisions ONE review sheet holds, and nothing else.
 *
 * A workflow's sheet reads that workflow's proposed fixes and its held
 * schedule; the skills sheet reads the proposed skills. Nothing the sheet does
 * not show is fetched, so a failure of an unrelated read cannot turn a fix into
 * an error — and a reader who may not read the target is told so rather than
 * left in front of a loading state that never ends.
 */
export function useReviewDecisions(
  target: ReviewTarget,
  permissions: readonly string[],
): ReviewDecisions {
  const { t } = useI18n();
  const access = reviewAccess(target, permissions);
  const names = useNameIndex(permissions, access === "readable");
  const query = useQuery({
    queryKey: ["decisions", "review", target],
    enabled: access === "readable",
    staleTime: 10_000,
    queryFn: async () => {
      if (target.kind === "skills") {
        const skills = await listProposedSkillCandidates();
        return { patches: [], skills: skills.items, held: [] as HeldSchedule[] };
      }
      if (target.kind !== "workflow") return { patches: [], skills: [], held: [] };
      const [patches, held] = await Promise.all([
        listProposedPatchCandidates(target.workflowId),
        listHeldSchedules(),
      ]);
      return {
        patches: patches.items,
        skills: [],
        held: held.filter((schedule) => schedule.workflow_id === target.workflowId),
      };
    },
  });
  const items = [
    ...(query.data?.patches ?? []).map((candidate) => {
      // The engine passes the repair model's English change note straight
      // through. It stays as the card's summary; the title is the German line
      // derived from what the decision is about.
      const kinds = patchChangeKind(candidate);
      const changeKey = proposalKindKey(kinds.proposalKind) ?? driftKindKey(kinds.driftKind);
      const title = patchTitle({
        workflow: candidate.workflow_name ?? null,
        change: changeKey ? t(changeKey) : null,
      });
      return patchDecision(candidate, t(title.key, title.params));
    }),
    ...(query.data?.skills ?? []).map((candidate) =>
      skillDecision(candidate, skillTargetName(names, candidate)),
    ),
  ];
  // One position is one decision, however often a source hands it out.
  const decisions = [...new Map(items.map((item) => [decisionKey(item), item])).values()].filter(
    isDecidable,
  ) as DecidableItem[];
  return {
    access,
    isPending: access === "readable" && query.isPending,
    // React Query retries before `error` is final; the failure shows at once.
    failed: Boolean(query.error ?? query.failureReason),
    decisions,
    held: query.data?.held ?? [],
    names,
    canReadRuns: permissions.includes("execution:read"),
    refetch: () => void query.refetch(),
  };
}
