import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  approvePatchCandidate,
  approveSkillCandidate,
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
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import {
  type DecidableItem,
  type DecidableKind,
  type DecisionItem,
  filterByKinds,
  isDecidable,
  partitionByUrgency,
} from "./decisions-model";

// Only actionable patches and knowledge activations belong in the decision count.
const KINDS: DecidableKind[] = ["patch", "skill"];
const KIND_LABEL: Record<DecidableKind, TranslationKey> = {
  patch: "decisions.kind.patch",
  skill: "decisions.kind.skill",
};

const PREFERENCE_KEY = "sk-cockpit-decisions";

interface Preferences {
  kinds: DecidableKind[];
}

function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return { kinds: [] };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      kinds: Array.isArray(parsed.kinds)
        ? parsed.kinds.filter((kind): kind is DecidableKind =>
            KINDS.includes(kind as DecidableKind),
          )
        : [],
    };
  } catch {
    return { kinds: [] };
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
  const [section, setSection] = useState<"decisions" | "suggestions" | "questions">("decisions");
  const [visibleCount, setVisibleCount] = useState(25);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills =
    session.permissions.includes("skill:write") && session.permissions.includes("skill:activate");
  const title = t("nav.decisions");

  function persist(next: Preferences): void {
    setPreferences(next);
    writePreferences(next);
  }

  const decide = useMutation({
    mutationFn: async (input: {
      item: DecisionItem;
      approve: boolean;
      reason: string;
      reviewDigest?: string;
    }) => {
      if (input.item.kind === "patch") {
        return input.approve
          ? approvePatchCandidate(input.item.id, input.reviewDigest ?? "")
          : rejectPatchCandidate(input.item.id, input.reason);
      }
      return input.approve
        ? approveSkillCandidate(input.item.id, input.item.reviewDigest ?? "")
        : rejectSkillCandidate(input.item.id, input.reason);
    },
    onMutate: (input) => {
      setBusyId(input.item.id);
    },
    onSuccess: async (_result, input) => {
      toast.success(t(input.approve ? "decisions.approved" : "decisions.rejected"));
      await queryClient.invalidateQueries({ queryKey: ["decisions"] });
      await queryClient.invalidateQueries({ queryKey: ["operational-overview"] });
      await queryClient.invalidateQueries({ queryKey: ["patch-candidate"] });
    },
    onError: (error) => {
      toast.error(t(decisionFailureKey(error)));
      void queryClient.invalidateQueries({ queryKey: ["decisions"] });
      void queryClient.invalidateQueries({ queryKey: ["patch-candidate"] });
    },
    onSettled: () => setBusyId(null),
  });

  // Only what can be decided reaches the queue. `queue.items` still carries the
  // waiting conversations and diagnostics for their separate sections.
  const open = queue.items.filter(isDecidable);
  const filtered = filterByKinds(open, preferences.kinds) as DecidableItem[];
  const initial = filtered.slice(0, visibleCount);
  const urgency = partitionByUrgency(initial, Date.now());
  const { current, aged } = urgency.deferred;
  const isFiltered = preferences.kinds.length > 0 && open.length > filtered.length;
  // The breakdown comes from the same count as the badge, not from the rows the
  // page happens to hold: the two disagreed the moment a source hit its cap.

  if (!queue.sources.patches && !queue.sources.skills && !queue.sources.conversations)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  function renderGroups(items: DecidableItem[], prefix: string, priority: "urgent" | "normal") {
    return items.map((item, index) => (
      <DecisionCard
        key={item.id}
        item={item}
        index={index}
        testIdPrefix={prefix}
        names={queue.names}
        canReadRuns={queue.canReadRuns}
        priority={priority}
        busy={busyId === item.id}
        canDecide={item.kind === "patch" ? canDecidePatches : canDecideSkills}
        onApprove={(target, reviewDigest) =>
          decide.mutate({ item: target, approve: true, reason: "", reviewDigest })
        }
        onReject={(target, reason) => decide.mutate({ item: target, approve: false, reason })}
      />
    ));
  }

  return (
    <PageFrame
      surface="decisions"
      testId="decisions-page"
      title={title}
      description={t("decisions.description")}
      scroll="page"
      width="workbench"
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
        {section === "decisions" &&
          queue.heldSchedules.map((schedule) => (
            <Alert key={schedule.id} variant="destructive" data-testid="schedule-admission-held">
              <AlertTitle>
                {schedule.workflow_name ?? schedule.workflow_slug ?? t("schedules.held.title")}
              </AlertTitle>
              <AlertDescription>
                <p>
                  {t(
                    schedule.admission_hold?.reason_code === "execution_authority_required"
                      ? "schedules.held.concrete"
                      : "schedules.held.authority",
                  )}
                </p>
                <p>
                  {schedule.cron} · {schedule.timezone} · {schedule.execution_mode}
                </p>
                <a
                  href={`/cockpit/workflows/${encodeURIComponent(schedule.workflow_id)}`}
                  className="underline underline-offset-4"
                >
                  {t("schedules.held.review")}
                </a>
              </AlertDescription>
            </Alert>
          ))}
        <fieldset className="flex flex-wrap gap-2" aria-label={t("nav.decisions")}>
          {(["decisions", "suggestions", "questions"] as const).map((value) => (
            <Button
              key={value}
              data-testid={`decisions-section-${value}`}
              variant={section === value ? "default" : "outline"}
              aria-pressed={section === value}
              onClick={() => setSection(value)}
            >
              {t(`decisions.section.${value}`)}
            </Button>
          ))}
        </fieldset>
        {section !== "decisions" && (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t("decisions.separateHint")}</p>
            {queue.items
              .filter((item) =>
                section === "questions"
                  ? item.kind === "conversation"
                  : item.kind !== "conversation" && !isDecidable(item),
              )
              .map((item) => (
                <Alert key={`${item.kind}:${item.id}`}>
                  <AlertTitle>{item.title}</AlertTitle>
                  <AlertDescription>
                    <p>{item.summary}</p>
                    <p>
                      {t(
                        item.kind === "patch"
                          ? patchSuggestionReason(item.reviewReason)
                          : "decisions.advisory",
                      )}
                    </p>
                    {item.kind === "conversation" && (
                      <Link
                        data-testid={`decision-question-${item.id}`}
                        to="/chat/$conversationId"
                        params={{ conversationId: item.id }}
                      >
                        {t("decisions.openQuestion")}
                      </Link>
                    )}
                  </AlertDescription>
                </Alert>
              ))}
          </div>
        )}
        {section === "decisions" && (
          <>
            <div data-family-slot="filters">
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="decisions-toolbar"
                data-family-slot="kind-filters"
              >
                <Button
                  variant={preferences.kinds.length === 0 ? "default" : "outline"}
                  size="sm"
                  data-testid="decisions-chip-all"
                  onClick={() => persist({ ...preferences, kinds: [] })}
                >
                  {t("decisions.chip.all")}
                </Button>
                {/* Art-Chips only. §8.5 forbids a chip that puts the queue into a past
              STATE — decided, discarded, deferred — and there is none: this list
              is closed over the two kinds the page can act on. */}
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
              </div>
            </div>

            <p className="text-sm text-muted-foreground" data-family-slot="queue-summary">
              {t("decisions.queueSummary", {
                count: String(queue.open?.decidable ?? open.length),
              })}
            </p>

            <div className="grid gap-5" data-family-slot="queue">
              {queue.isPending && !queue.failed ? (
                <div
                  className="grid gap-2"
                  role="status"
                  aria-label={t("common.loading")}
                  aria-busy="true"
                  data-family-slot="data-state"
                  data-family-state="loading"
                >
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : queue.failed ? (
                <Alert
                  variant="destructive"
                  data-testid="decisions-error"
                  data-family-slot="data-state"
                  data-family-state="error"
                >
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
                    className="flex min-h-32 flex-col items-center justify-center rounded-lg border p-4 text-center"
                    data-testid="decisions-empty-filtered"
                    data-family-slot="data-state"
                    data-family-state="filtered-empty"
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
                ) : queue.heldSchedules.length > 0 ? null : (
                  <div
                    className="flex min-h-32 flex-col items-center justify-center rounded-lg border p-4 text-center"
                    data-testid="decisions-empty"
                    data-family-slot="data-state"
                    data-family-state="empty"
                  >
                    <CircleCheck
                      aria-hidden="true"
                      className="mx-auto size-6 text-emerald-600 dark:text-emerald-400"
                    />
                    <p className="mt-2 text-sm font-medium">{t("decisions.emptyTitle")}</p>
                    <p className="text-sm text-muted-foreground">
                      {t("decisions.emptyDescription")}
                    </p>
                  </div>
                )
              ) : (
                // Keep the queue count machine-readable so the shared parity check
                // can compare the visible rows with the navigation badge.
                <div
                  className="grid gap-5"
                  data-testid="decisions-queue"
                  data-total={String(queue.open?.decidable ?? 0)}
                  data-capped={String(queue.open?.capped ?? false)}
                >
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
                      bucket="overdue"
                    >
                      {renderGroups(aged as DecidableItem[], "decision-aged", "urgent")}
                    </DecisionSection>
                  )}
                  {current.length > 0 && (
                    <DecisionSection
                      testId="decisions-current"
                      title={t("operational.core.other")}
                      hint={t("decisions.section.deferredHint")}
                      count={current.length}
                      bucket="other"
                    >
                      {renderGroups(current as DecidableItem[], "decision-deferred", "normal")}
                    </DecisionSection>
                  )}
                </div>
              )}
            </div>

            {filtered.length > visibleCount && (
              <Button
                data-testid="decisions-load-more"
                variant="outline"
                onClick={() => setVisibleCount((count) => count + 25)}
              >
                {t("decisions.loadMore")}
              </Button>
            )}
          </>
        )}
        <HistoryLink />
      </div>
    </PageFrame>
  );
}

/**
 * §8.5 — the one way to the past, and the only one.
 *
 * Not a shelf, not a section, not a state chip: a sentence with a link. The
 * history it points at is complete because the audit log is append-only; what
 * the log does NOT cover is said on that page rather than implied here.
 */
function patchSuggestionReason(reason?: string | null): TranslationKey {
  if (reason === "no_step_anchor" || reason === "step_not_found")
    return "decisions.reason.noAnchor";
  if (reason === "no_change") return "decisions.reason.noChange";
  if (reason === "workflow_missing" || reason === "version_missing")
    return "decisions.reason.missingWorkflow";
  return "decisions.notApplicable";
}

function decisionFailureKey(error: unknown): TranslationKey {
  if (error instanceof ApiError) {
    if (error.code === "review_changed") return "decisions.reviewChanged";
    if (
      [
        "no_step_anchor",
        "step_not_found",
        "patch_not_applicable",
        "no_change",
        "workflow_missing",
        "invalid_proposal",
        "unsupported_step_kind",
      ].includes(error.code ?? "")
    )
      return "decisions.notApplicable";
  }
  return "decisions.decisionFailed";
}

function HistoryLink() {
  const { t } = useI18n();
  const session = useSession();
  if (!session.permissions.includes("audit:read")) return null;
  return (
    <div data-family-slot="audit-link">
      <p
        className="text-sm text-muted-foreground"
        data-testid="decisions-history"
        data-family-slot="audit-meta"
      >
        {t("decisions.history.label")}{" "}
        <Link
          to="/audit"
          search={{ scope: "decisions" }}
          className="underline underline-offset-2"
          data-testid="decisions-history-link"
        >
          {t("decisions.history.link")}
        </Link>
      </p>
    </div>
  );
}

/** One rubric of the queue: what it is, what it costs, and how many. */
function DecisionSection({
  testId,
  title,
  hint,
  count,
  bucket,
  muted = false,
  children,
}: {
  testId: string;
  title: string;
  hint: string;
  count: number;
  bucket: "overdue" | "other";
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    // The count is readable as a number, not only as rendered text: the banner
    // states a share of this rubric, and the two are asserted against each
    // other rather than trusted to stay in step.
    <section
      className={cn("grid gap-2", muted && "opacity-70")}
      data-testid={testId}
      data-count={String(count)}
      data-family-decision-bucket={bucket}
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold" data-family-slot="decision-group-title">
          {title}
        </h2>
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}
