import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import {
  type HeldSchedule,
  type InboundHookAutomation,
  listHeldInboundHooks,
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
import { driftKindKey, fixerKey, proposalKindKey } from "@/pages/decisions-context";
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
import { useLiveQueryOptions } from "./live-events";

export function useNameIndex(permissions: readonly string[], enabled: boolean): NameIndex {
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

export function useHeldSchedules(permissions: readonly string[]): HeldSchedule[] {
  const live = useLiveQueryOptions();
  const query = useQuery({
    queryKey: ["decisions", "held"],
    enabled: permissions.includes("workflow:read"),
    ...live,
    staleTime: 30_000,
    queryFn: listHeldSchedules,
  });
  return query.data ?? [];
}

interface ReviewDecisions {
  access: ReviewAccess;
  isPending: boolean;
  failed: boolean;
  decisions: DecidableItem[];
  held: HeldSchedule[];
  heldHooks: InboundHookAutomation[];
  names: NameIndex;
  canReadRuns: boolean;
  refetch: () => void;
}

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
        return {
          patches: [],
          skills: skills.items,
          held: [] as HeldSchedule[],
          heldHooks: [] as InboundHookAutomation[],
        };
      }
      if (target.kind !== "workflow") return { patches: [], skills: [], held: [], heldHooks: [] };
      const [patches, held, heldHooks] = await Promise.all([
        listProposedPatchCandidates(target.workflowId),
        listHeldSchedules(),
        permissions.includes("schedule:read")
          ? listHeldInboundHooks(target.workflowId)
          : ([] as InboundHookAutomation[]),
      ]);
      return {
        patches: patches.items,
        skills: [],
        held: held.filter((schedule) => schedule.workflow_id === target.workflowId),
        heldHooks,
      };
    },
  });
  const items = [
    ...(query.data?.patches ?? []).map((candidate) => {
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
    ...(query.data?.skills ?? []).map((candidate) =>
      skillDecision(candidate, skillTargetName(names, candidate)),
    ),
  ];
  const decisions = [...new Map(items.map((item) => [decisionKey(item), item])).values()].filter(
    isDecidable,
  ) as DecidableItem[];
  return {
    access,
    isPending: access === "readable" && query.isPending,
    failed: Boolean(query.error ?? query.failureReason),
    decisions,
    held: query.data?.held ?? [],
    heldHooks: query.data?.heldHooks ?? [],
    names,
    canReadRuns: permissions.includes("execution:read"),
    refetch: () => void query.refetch(),
  };
}
