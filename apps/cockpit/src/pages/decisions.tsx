import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  listPatchCandidatesByStatus,
  listSkillCandidatesByStatus,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import { useSession } from "@/app/session";
import { useDecisionQueue } from "@/app/use-decisions";
import { ContextHelp } from "@/components/cockpit/context-help";
import { DecisionCard } from "@/components/cockpit/decision-card";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type DecisionItem,
  type DecisionKind,
  filterByKinds,
  type GroupMode,
  groupDecisions,
  splitByAge,
} from "./decisions-model";

const KINDS: DecisionKind[] = ["conversation", "patch", "skill"];
const GROUP_MODES: GroupMode[] = ["none", "kind", "source"];
const KIND_LABEL: Record<DecisionKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
  conversation: "decisions.kind.conversation",
};
const GROUP_LABEL: Record<GroupMode, TranslationKey> = {
  none: "decisions.group.none",
  kind: "decisions.group.kind",
  source: "decisions.group.source",
};
const PREFERENCE_KEY = "sk-cockpit-decisions";

interface Preferences {
  kinds: DecisionKind[];
  group: GroupMode;
}

function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return { kinds: [], group: "none" };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      kinds: Array.isArray(parsed.kinds)
        ? parsed.kinds.filter((kind): kind is DecisionKind => KINDS.includes(kind as DecisionKind))
        : [],
      group: GROUP_MODES.includes(parsed.group as GroupMode) ? (parsed.group as GroupMode) : "none",
    };
  } catch {
    return { kinds: [], group: "none" };
  }
}

function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
  } catch {
    // A cockpit that cannot persist a filter still works; the filter simply resets.
  }
}

export function DecisionsPage() {
  const { t } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const queue = useDecisionQueue(session.permissions);
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [decided, setDecided] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills = session.permissions.includes("skill:write");
  const title = t("nav.decisions");

  function persist(next: Preferences): void {
    setPreferences(next);
    writePreferences(next);
  }

  const decide = useMutation({
    mutationFn: async (input: { item: DecisionItem; approve: boolean; reason: string }) => {
      if (input.item.kind === "patch") {
        return input.approve
          ? approvePatchCandidate(input.item.id)
          : rejectPatchCandidate(input.item.id, input.reason);
      }
      return input.approve
        ? approveSkillCandidate(input.item.id)
        : rejectSkillCandidate(input.item.id, input.reason);
    },
    onMutate: (input) => {
      setBusyId(input.item.id);
      setDecided((ids) => [...ids, input.item.id]);
    },
    onSuccess: (_result, input) => {
      toast.success(t(input.approve ? "decisions.approved" : "decisions.rejected"));
      void queryClient.invalidateQueries({ queryKey: ["decisions"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (_error, input) => {
      setDecided((ids) => ids.filter((id) => id !== input.item.id));
      toast.error(t("decisions.decisionFailed"));
    },
    onSettled: () => setBusyId(null),
  });

  const open = queue.items.filter((item) => !decided.includes(item.id));
  const filtered = filterByKinds(open, preferences.kinds);
  const { current, aged } = splitByAge(filtered, Date.now());
  const isFiltered = preferences.kinds.length > 0 && open.length > filtered.length;

  if (!queue.sources.patches && !queue.sources.skills && !queue.sources.conversations)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  function renderGroups(items: DecisionItem[], prefix: string) {
    const groups = groupDecisions(items, preferences.group);
    let position = 0;
    return groups.map((group) => (
      <div key={group.key} className="grid gap-2">
        {preferences.group !== "none" && (
          <p className="text-xs font-medium text-muted-foreground">
            {preferences.group === "kind"
              ? t(KIND_LABEL[group.key as DecisionKind])
              : group.key || t("decisions.group.noSource")}
          </p>
        )}
        {group.items.map((item) => {
          const index = position++;
          return (
            <DecisionCard
              key={item.id}
              item={item}
              index={index}
              testIdPrefix={prefix}
              busy={busyId === item.id}
              canDecide={item.kind === "patch" ? canDecidePatches : canDecideSkills}
              onApprove={(target) => decide.mutate({ item: target, approve: true, reason: "" })}
              onReject={(target, reason) => decide.mutate({ item: target, approve: false, reason })}
            />
          );
        })}
      </div>
    ));
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="decisions-page">
      <header
        className="flex shrink-0 flex-col items-stretch justify-between gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:px-8"
        data-testid="decisions-header"
      >
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          <ContextHelp
            label={t("resource.about", { resource: title })}
            testId="decisions-description"
          >
            {t("decisions.description")}
          </ContextHelp>
        </div>
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="decisions-refresh"
          onClick={() => queue.refetch()}
        >
          <RefreshCw className={queue.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto grid w-full max-w-[780px] gap-4">
          <div className="flex flex-wrap items-center gap-2" data-testid="decisions-toolbar">
            <Button
              variant={preferences.kinds.length === 0 ? "default" : "outline"}
              size="sm"
              data-testid="decisions-chip-all"
              onClick={() => persist({ ...preferences, kinds: [] })}
            >
              {t("decisions.chip.all")}
            </Button>
            {KINDS.map((kind, index) => (
              <Button
                key={kind}
                variant={preferences.kinds.includes(kind) ? "default" : "outline"}
                size="sm"
                data-testid={`decisions-chip-${index}`}
                onClick={() =>
                  persist({
                    ...preferences,
                    kinds: preferences.kinds.includes(kind)
                      ? preferences.kinds.filter((entry) => entry !== kind)
                      : [...preferences.kinds, kind],
                  })
                }
              >
                {t(KIND_LABEL[kind])}
              </Button>
            ))}
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("decisions.group.label")}</span>
              {GROUP_MODES.map((mode, index) => (
                <Button
                  key={mode}
                  variant={preferences.group === mode ? "default" : "ghost"}
                  size="sm"
                  data-testid={`decisions-group-${index}`}
                  onClick={() => persist({ ...preferences, group: mode })}
                >
                  {t(GROUP_LABEL[mode])}
                </Button>
              ))}
            </span>
          </div>

          {queue.isPending ? (
            <div className="grid gap-2" role="status" aria-label={t("common.loading")}>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : queue.failed ? (
            <Alert variant="destructive" data-testid="decisions-error">
              <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
              <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                data-testid="decisions-retry"
                onClick={() => queue.refetch()}
              >
                {t("session.retry")}
              </Button>
            </Alert>
          ) : filtered.length === 0 ? (
            isFiltered ? (
              <div
                className="rounded-lg border p-6 text-center"
                data-testid="decisions-empty-filtered"
              >
                <p className="text-sm font-medium">{t("decisions.emptyFiltered")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  data-testid="decisions-show-all"
                  onClick={() => persist({ ...preferences, kinds: [] })}
                >
                  {t("decisions.showAll")}
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border p-6 text-center" data-testid="decisions-empty">
                <CircleCheck
                  aria-hidden="true"
                  className="mx-auto size-6 text-emerald-600 dark:text-emerald-400"
                />
                <p className="mt-2 text-sm font-medium">{t("decisions.emptyTitle")}</p>
                <p className="text-sm text-muted-foreground">{t("decisions.emptyDescription")}</p>
              </div>
            )
          ) : (
            <>
              {current.length > 0 && (
                <section className="grid gap-2" data-testid="decisions-current">
                  {renderGroups(current, "decision")}
                </section>
              )}
              {aged.length > 0 && (
                <section className="grid gap-2" data-testid="decisions-aged">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold">{t("decisions.agedTitle")}</h2>
                    <Badge variant="secondary" className="tabular-nums">
                      {aged.length}
                    </Badge>
                  </div>
                  {renderGroups(aged, "decision-aged")}
                </section>
              )}
            </>
          )}

          <DecisionShelf
            titleKey="decisions.shelf.decided"
            testId="decisions-shelf-decided"
            enabled={queue.sources.patches || queue.sources.skills}
            load={async () => {
              const [patches, skills] = await Promise.all([
                queue.sources.patches ? listPatchCandidatesByStatus("applied") : null,
                queue.sources.skills ? listSkillCandidatesByStatus("approved") : null,
              ]);
              return [
                ...(patches?.items ?? []).map((entry) => entry.workflow_name ?? entry.workflow_id),
                ...(skills?.items ?? []).map((entry) => entry.title),
              ];
            }}
          />
          <DecisionShelf
            titleKey="decisions.shelf.discarded"
            testId="decisions-shelf-discarded"
            enabled={queue.sources.patches || queue.sources.skills}
            load={async () => {
              const [patches, skills] = await Promise.all([
                queue.sources.patches ? listPatchCandidatesByStatus("rejected") : null,
                queue.sources.skills ? listSkillCandidatesByStatus("rejected") : null,
              ]);
              return [
                ...(patches?.items ?? []).map((entry) => entry.workflow_name ?? entry.workflow_id),
                ...(skills?.items ?? []).map((entry) => entry.title),
              ];
            }}
          />
        </div>
      </div>
    </main>
  );
}

interface DecisionShelfProps {
  titleKey: TranslationKey;
  testId: string;
  enabled: boolean;
  load: () => Promise<string[]>;
}

function DecisionShelf({ titleKey, testId, enabled, load }: DecisionShelfProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["decisions", "shelf", testId],
    enabled: enabled && open,
    queryFn: load,
  });

  if (!enabled) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start opacity-70"
          data-testid={`${testId}-toggle`}
        >
          {t(titleKey)}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-1 px-3 pb-3 text-sm text-muted-foreground opacity-70">
        {query.isPending ? (
          <span>{t("common.loading")}</span>
        ) : query.error ? (
          <span>{t("resource.loadFailedDescription")}</span>
        ) : query.data && query.data.length > 0 ? (
          query.data.map((entry, index) => (
            <span key={`${entry}-${index}`} data-testid={`${testId}-item-${index}`}>
              {entry}
            </span>
          ))
        ) : (
          <span data-testid={`${testId}-empty`}>{t("decisions.shelf.empty")}</span>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
