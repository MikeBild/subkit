import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
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
import { DecisionCard } from "@/components/cockpit/decision-card";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  type DecisionItem,
  type DecisionKind,
  filterByKinds,
  type GroupMode,
  groupDecisions,
  partitionByUrgency,
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
  const urgency = partitionByUrgency(filtered, Date.now());
  const { current, aged } = urgency.deferred;
  const isFiltered = preferences.kinds.length > 0 && open.length > filtered.length;
  // The breakdown comes from the same count as the badge, not from the rows the
  // page happens to hold: the two disagreed the moment a source hit its cap.
  const counted = queue.open;

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
      <div key={group.key} className="grid gap-2 pt-2 first:pt-0">
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
              names={queue.names}
              canReadRuns={queue.canReadRuns}
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
    <PageFrame
      testId="decisions-page"
      title={title}
      description={t("decisions.description")}
      scroll="page"
      action={
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="decisions-refresh"
          onClick={() => queue.refetch()}
        >
          <RefreshCw className={queue.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      }
    >
      <div className="grid gap-6">
        {/* The number on the badge used to stand alone, which made it read as a
            demand of unknown origin. Naming its three sources answers "where do
            these come from" before anyone has to ask. */}
        {counted !== null && counted.total > 0 && (
          <p className="-mt-2 text-xs text-muted-foreground" data-testid="decisions-sources">
            {t("decisions.sources", {
              total: String(counted.total),
              patches: String(counted.byKind.patch),
              skills: String(counted.byKind.skill),
              conversations: String(counted.byKind.conversation),
            })}
            {counted.capped
              ? ` ${t("decisions.capped", {
                  shown: String(queue.items.length),
                  total: String(counted.total),
                })}`
              : ""}
          </p>
        )}
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
          <span className="flex items-center gap-2 sm:ml-auto">
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
              className="flex min-h-52 flex-col items-center justify-center rounded-lg border p-4 text-center"
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
            <div
              className="flex min-h-52 flex-col items-center justify-center rounded-lg border p-4 text-center"
              data-testid="decisions-empty"
            >
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
            {urgency.expired.length > 0 && (
              <DecisionSection
                testId="decisions-expired"
                title={t("decisions.section.expired")}
                hint={t("decisions.section.expiredHint")}
                count={urgency.expired.length}
                muted
              >
                {renderGroups(urgency.expired, "decision-expired")}
              </DecisionSection>
            )}
            {urgency.blocking.length > 0 && (
              <DecisionSection
                testId="decisions-blocking"
                title={t("decisions.section.blocking")}
                hint={t("decisions.section.blockingHint")}
                count={urgency.blocking.length}
              >
                {renderGroups(urgency.blocking, "decision")}
              </DecisionSection>
            )}
            {(current.length > 0 || aged.length > 0) && (
              // The queue's own copy of the one number, so a drift between
              // badge, Zone A and this page is a failing assertion rather than
              // something a reader has to notice.
              <div
                className="grid gap-6"
                data-testid="decisions-queue"
                data-total={String(counted?.total ?? 0)}
                data-capped={String(counted?.capped ?? false)}
              >
                {current.length > 0 && (
                  <DecisionSection
                    testId="decisions-current"
                    title={t("decisions.section.deferred")}
                    hint={t("decisions.section.deferredHint")}
                    count={current.length}
                  >
                    {renderGroups(current, "decision-deferred")}
                  </DecisionSection>
                )}
                {/* §8.2 names this rubric, and it is a rubric of its own rather
                    than a sub-heading inside another one: it used to sit under
                    a section headed "Kann warten", which is the product
                    deciding on the reader's behalf what it has no way to know. */}
                {aged.length > 0 && (
                  <DecisionSection
                    testId="decisions-aged"
                    title={t("decisions.agedTitle")}
                    hint={t("decisions.agedHint")}
                    count={aged.length}
                  >
                    {renderGroups(aged, "decision-aged")}
                  </DecisionSection>
                )}
              </div>
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
              ...(patches?.items ?? []).map(
                (entry) => entry.workflow_name ?? t("decisions.fallbackTitle.patch"),
              ),
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
              ...(patches?.items ?? []).map(
                (entry) => entry.workflow_name ?? t("decisions.fallbackTitle.patch"),
              ),
              ...(skills?.items ?? []).map((entry) => entry.title),
            ];
          }}
        />
      </div>
    </PageFrame>
  );
}

/** One rubric of the queue: what it is, what it costs, and how many. */
function DecisionSection({
  testId,
  title,
  hint,
  count,
  muted = false,
  children,
}: {
  testId: string;
  title: string;
  hint: string;
  count: number;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn("grid gap-2", muted && "opacity-70")} data-testid={testId}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>
      {children}
    </section>
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
          className="w-full justify-start px-4 opacity-70"
          data-testid={`${testId}-toggle`}
        >
          {t(titleKey)}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-1 px-4 pb-4 text-sm text-muted-foreground opacity-70">
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
