import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import {
  absolute,
  attentionHref,
  auditHref,
  reviewFromUrl,
  routerPath,
  routerTarget,
} from "@/app/links";
import { visibleNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { hideAttentionEntry, restoreAttentionEntry, useAttention } from "@/app/use-attention";
import { useReviewDecisions } from "@/app/use-decisions";
import { DecisionCard } from "@/components/cockpit/decision-card";
import { InboundHookReviewCard } from "@/components/cockpit/inbound-hook-review-card";
import { PageFrame } from "@/components/cockpit/page-frame";
import { ScheduleReviewCard } from "@/components/cockpit/schedule-review-card";
import { LoadFailed } from "@/components/failure-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { EngineWording } from "@/lib/machine-label";
import { cn } from "@/lib/utils";
import type { DecisionItem } from "./decisions-model";
import { OperationsBar, useOperationsFigures, WindowSwitch } from "./operations-bar";
import { type WindowBounds, windowBounds } from "./operations-figures";
import {
  type AttentionAction,
  type AttentionItem,
  type AttentionSentence,
  actionLabelKey,
  attentionSentence,
  entryActions,
  overviewSections,
  overviewView,
  reviewNavigation,
  reviewTarget,
  sourceLabel,
  statusLine,
} from "./overview-model";

/** A plain left click stays in the page; anything else is the browser's. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const CLASS_WEIGHT: Record<AttentionItem["class"], string> = {
  stopped: "border-l-4 border-l-destructive",
  failing: "border-l-4 border-l-amber-500",
  decide: "border-l-2 border-l-border",
};

/**
 * Übersicht: the installation's four operating figures over one window, then
 * what needs the reader now, one entry per subject, each with one way to act
 * on it. Tasks live here and nowhere else — the object pages show their state
 * and at most link here. The figures stay in the calm state too: they are
 * numbers to read, never tasks, and each opens the list it counts.
 */
export function OverviewPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const attention = useAttention(session.permissions);
  // The window as two fixed instants, set when it is chosen: the figures and
  // the lists they link to count over the very same bounds.
  const [bounds, setBounds] = useState<WindowBounds>(() => windowBounds("24h"));
  const operations = useOperationsFigures(bounds, session.permissions);
  const href = useRouterState({ select: (state) => state.location.href });
  const [review, setReview] = useState<string | null>(() => reviewFromUrl(window.location.search));

  // The sheet follows the address: Back closes it, a link opens it, and a
  // router navigation to the Übersicht (the sidebar entry) lands without it.
  useEffect(() => {
    void href;
    setReview(reviewFromUrl(window.location.search));
  }, [href]);
  useEffect(() => {
    const onPopState = () => setReview(reviewFromUrl(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigation = useMemo(
    () => reviewNavigation(window.history, (id) => absolute(attentionHref({ review: id }))),
    [],
  );
  const openReview = useCallback(
    (id: string) => {
      navigation.open(id);
      setReview(id);
    },
    [navigation],
  );
  // Closing leaves no history entry behind: Back after a closed sheet goes
  // where the reader was before it opened, never into the sheet again.
  const closeReview = useCallback(() => {
    navigation.close();
    setReview(null);
  }, [navigation]);

  // Nobody reads the Übersicht who may read none of its sources: they land on the
  // first page they can see, not on a page that can only ever be empty.
  const fallback = attention.enabled
    ? null
    : (visibleNavigation(session.permissions)
        .flatMap((group) => group.items)
        .find((item) => item.path !== "/")?.path ?? null);
  useEffect(() => {
    if (fallback) window.location.replace(absolute(fallback));
  }, [fallback]);

  const title = t("overview.title");
  if (!attention.enabled) {
    return fallback ? (
      <main className="p-6" aria-busy="true" data-testid="attention-redirect" />
    ) : (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );
  }

  const data = attention.query.data;
  const view = data ? overviewView(data, attention.hidden) : null;
  const now = Date.now();
  const reviewed = review ? (data?.items.find((item) => item.id === review) ?? null) : null;
  const canHistory = session.permissions.includes("audit:read");
  const sections = view
    ? overviewSections(view, { operations: operations.allowed, history: canHistory })
    : null;

  const bar = (
    <OperationsBar
      figures={operations.figures}
      pending={operations.pending}
      onRetry={operations.retry}
    />
  );
  const history = (
    <p className="text-sm text-muted-foreground" data-testid="attention-history">
      <Link
        to={auditHref({ scope: "decisions" })}
        className="underline underline-offset-2"
        data-testid="attention-history-link"
      >
        {t("overview.history.link")}
      </Link>
    </p>
  );

  return (
    <PageFrame
      surface="overview"
      testId="attention-page"
      title={title}
      scroll="page"
      action={
        operations.allowed ? (
          <WindowSwitch value={bounds.window} onChange={(next) => setBounds(windowBounds(next))} />
        ) : undefined
      }
    >
      <div className="grid gap-6">
        {attention.query.isPending ? (
          <>
            {operations.allowed ? bar : null}
            <div
              className="grid gap-2"
              role="status"
              aria-label={t("common.loading")}
              aria-busy="true"
              data-family-slot="data-state"
              data-family-state="loading"
            >
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
            {canHistory ? history : null}
          </>
        ) : attention.query.isError || !view || !sections ? (
          <>
            {operations.allowed ? bar : null}
            <LoadFailed
              title={t("overview.loadFailed")}
              onRetry={() => void attention.query.refetch()}
              testId="attention-error"
            />
            {canHistory ? history : null}
          </>
        ) : view.kind === "nothing_readable" ? (
          <>
            {operations.allowed ? bar : null}
            <Alert data-testid="resource-permission-alert">
              <AlertTitle>{t("resource.permission.title")}</AlertTitle>
              <AlertDescription>{t("resource.permission.description")}</AlertDescription>
            </Alert>
            {canHistory ? history : null}
          </>
        ) : (
          sections.map((section) => {
            if (section === "operations") return <div key={section}>{bar}</div>;
            if (section === "history") return <div key={section}>{history}</div>;
            if (section === "calm")
              return (
                <CalmState
                  key={section}
                  line={view.kind === "calm" ? statusLine(view.status, t, dateTime) : null}
                />
              );
            if (section === "unread")
              return (
                <UnreadSources
                  key={section}
                  sources={view.kind === "items" || view.kind === "unread" ? view.unread : []}
                  onRetry={() => void attention.query.refetch()}
                />
              );
            return view.kind === "items" ? (
              <section
                key={section}
                className="grid gap-2"
                aria-labelledby="attention-heading"
                data-testid="attention-section"
              >
                <h2 id="attention-heading" className="text-sm font-medium">
                  {t("overview.attention.title")}
                </h2>
                <ol
                  className="grid gap-2"
                  data-testid="attention-list"
                  data-family-slot="attention-list"
                >
                  {view.items.map((item, index) => (
                    <AttentionEntry
                      key={item.id}
                      item={item}
                      index={index}
                      sentence={attentionSentence(item, t, now)}
                      permissions={session.permissions}
                      onReview={openReview}
                    />
                  ))}
                </ol>
              </section>
            ) : null;
          })
        )}
      </div>
      <ReviewSheet id={review} item={reviewed} now={now} onClose={closeReview} />
    </PageFrame>
  );
}

function CalmState({ line }: { line: string | null }) {
  const { t } = useI18n();
  return (
    <div
      className="flex flex-col items-start gap-1 py-6"
      data-testid="attention-calm"
      data-family-slot="data-state"
      data-family-state="empty"
    >
      <p className="flex items-center gap-2 text-base font-medium">
        <CircleCheck aria-hidden="true" className="size-5 text-emerald-600 dark:text-emerald-400" />
        {t("overview.calm")}
      </p>
      {line ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="attention-status"
          data-family-slot="status-line"
        >
          {line}
        </p>
      ) : null}
    </div>
  );
}

function UnreadSources({
  sources,
  onRetry,
}: {
  sources: readonly Parameters<typeof sourceLabel>[0][];
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (sources.length === 0) return null;
  return (
    <LoadFailed
      title={t("overview.unread.title")}
      description={t("overview.unread.description", {
        sources: sources.map((source) => sourceLabel(source, t)).join(", "),
      })}
      onRetry={onRetry}
      testId="attention-unread"
    />
  );
}

function SentenceText({ sentence }: { sentence: AttentionSentence }) {
  return (
    <>
      {sentence.lead}
      {sentence.machine ? (
        <>
          {" ("}
          <code className="font-mono text-xs" data-machine-value="true">
            {sentence.machine}
          </code>
          {")"}
        </>
      ) : null}
      {sentence.since ? ` — ${sentence.since}` : null}.
    </>
  );
}

function AttentionEntry({
  item,
  index,
  sentence,
  permissions,
  onReview,
}: {
  item: AttentionItem;
  index: number;
  sentence: AttentionSentence;
  permissions: readonly string[];
  onReview: (id: string) => void;
}) {
  const { t } = useI18n();
  const { primary, secondary } = entryActions(item);
  const testId = `attention-item-${index}`;
  return (
    <li
      data-testid={testId}
      data-attention-id={item.id}
      data-attention-class={item.class}
      data-family-slot="decision-row"
    >
      {/* The entry is a card of its own: its edge — not the sentence padded
          inside it — lines up under the page heading. */}
      <article
        className={cn(
          "flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between",
          CLASS_WEIGHT[item.class],
        )}
      >
        <p className="min-w-0 break-words text-sm" data-testid={`${testId}-text`}>
          <SentenceText sentence={sentence} />
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          {secondary ? (
            <ActionLink
              action={secondary}
              item={item}
              permissions={permissions}
              testId={`${testId}-secondary`}
              onReview={onReview}
              variant="link"
              label={t(actionLabelKey(secondary, item))}
            />
          ) : null}
          {primary ? (
            <ActionLink
              action={primary}
              item={item}
              permissions={permissions}
              testId={`${testId}-primary`}
              onReview={onReview}
              variant="primary"
              label={t(actionLabelKey(primary, item))}
            />
          ) : null}
        </div>
      </article>
    </li>
  );
}

function ActionLink({
  action,
  item,
  permissions,
  testId,
  onReview,
  variant,
  label,
}: {
  action: AttentionAction;
  item: AttentionItem;
  permissions: readonly string[];
  testId: string;
  onReview: (id: string) => void;
  variant: "primary" | "link";
  label: string;
}) {
  const { t } = useI18n();
  // The engine names the permission acting here needs. A reader without it
  // sees the step, disabled — hiding it would say there is nothing to do.
  const allowed = permissions.includes(action.permission);
  if (!allowed) {
    return (
      <Button
        size="sm"
        variant={variant === "primary" ? "default" : "link"}
        disabled
        title={t("overview.notPermitted")}
        data-testid={testId}
        data-attention-verb={action.verb}
      >
        {label}
      </Button>
    );
  }
  const path = routerPath(action.href);
  if (action.verb === "review") {
    return (
      <Button size="sm" variant={variant === "primary" ? "default" : "link"} asChild>
        <a
          href={absolute(path)}
          data-testid={testId}
          data-attention-verb={action.verb}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onReview(item.id);
          }}
        >
          {label}
        </a>
      </Button>
    );
  }
  // An address may name a place ON a page — a workflow's automation panel.
  return (
    <Button size="sm" variant={variant === "primary" ? "default" : "link"} asChild>
      <Link {...routerTarget(action.href)} data-testid={testId} data-attention-verb={action.verb}>
        {label}
      </Link>
    </Button>
  );
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

/**
 * One entry's decisions, in a sheet over the Übersicht.
 *
 * The cards are the ones the decisions queue always used — the same diff, dry
 * run, approve and reject — narrowed to this entry's subject: a workflow's
 * proposed fixes and its held schedule, or the open skill proposals. The
 * engine's own wording about the entry is shown here, and only here, marked as
 * the engine's.
 */
function ReviewSheet({
  id,
  item,
  now,
  onClose,
}: {
  id: string | null;
  item: AttentionItem | null;
  now: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-2xl"
        closeLabel={t("common.close")}
        closeTestId="attention-review-close"
        data-testid="attention-review"
        data-family-slot="review-sheet"
        aria-describedby={undefined}
      >
        <SheetHeader>
          <SheetTitle data-testid="attention-review-title" className="pr-8">
            {item ? (
              <SentenceText sentence={attentionSentence(item, t, now)} />
            ) : (
              t("overview.sheet.title")
            )}
          </SheetTitle>
          {item?.detail ? (
            <EngineWording text={item.detail} testId="attention-review-detail" />
          ) : null}
        </SheetHeader>
        {id ? <ReviewBody id={id} item={item} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function ReviewBody({
  id,
  item,
  onClose,
}: {
  id: string;
  item: AttentionItem | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const target = reviewTarget(id);
  const review = useReviewDecisions(target, session.permissions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills =
    session.permissions.includes("skill:write") && session.permissions.includes("skill:activate");
  const { decisions, held, heldHooks } = review;

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
      // The last open decision of this entry settles it: the entry leaves the
      // list at once — before the engine has answered — and comes back if the
      // decision fails. The sheet stays until the answer, so a refusal is read
      // on the card it is about.
      const remaining = decisions.filter((entry) => entry.id !== input.item.id).length;
      const settles = remaining === 0 && held.length === 0 && heldHooks.length === 0;
      if (settles && item) hideAttentionEntry(item);
      return { settles };
    },
    onSuccess: async (_result, input, context) => {
      if (context?.settles) onClose();
      toast.success(t(input.approve ? "decisions.approved" : "decisions.rejected"), {
        description: (
          <a
            href={absolute(
              auditHref({
                resourceType: input.item.kind === "patch" ? "patch_candidate" : "skill_candidate",
                resourceId: input.item.id,
              }),
            )}
            className="underline underline-offset-2"
            data-testid="attention-decided-audit"
          >
            {t("overview.decided.audit")}
          </a>
        ),
      });
      await queryClient.invalidateQueries({ queryKey: ["decisions"] });
      await queryClient.invalidateQueries({ queryKey: ["attention"] });
      await queryClient.invalidateQueries({ queryKey: ["patch-candidate"] });
    },
    onError: (error) => {
      restoreAttentionEntry(id);
      toast.error(t(decisionFailureKey(error)));
      void queryClient.invalidateQueries({ queryKey: ["decisions"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
      void queryClient.invalidateQueries({ queryKey: ["patch-candidate"] });
    },
    onSettled: () => setBusyId(null),
  });

  const { primary } = item ? entryActions(item) : { primary: null };
  const back = (
    <Button
      variant="outline"
      className="justify-self-start"
      onClick={onClose}
      data-testid="attention-review-back"
    >
      {t("overview.sheet.close")}
    </Button>
  );
  // Where the entry is acted on, when not in this sheet.
  const elsewhere =
    item && primary && primary.verb !== "review" ? (
      <Button asChild className="justify-self-start">
        <Link {...routerTarget(primary.href)} data-testid="attention-review-action">
          {t(actionLabelKey(primary, item))}
        </Link>
      </Button>
    ) : null;

  if (review.access !== "readable")
    return (
      <div className="grid gap-3 px-4 pb-6" data-testid="attention-review-body">
        <p
          className="text-sm text-muted-foreground"
          data-testid={
            review.access === "not_permitted"
              ? "attention-review-not-permitted"
              : "attention-review-nothing"
          }
        >
          {t(
            review.access === "not_permitted"
              ? "overview.sheet.notPermitted"
              : "overview.sheet.nothingToReview",
          )}
        </p>
        {elsewhere}
        {back}
      </div>
    );
  if (review.isPending && !review.failed)
    return (
      <div
        className="grid gap-2 px-4"
        role="status"
        aria-label={t("common.loading")}
        aria-busy="true"
      >
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (review.failed)
    return (
      <div className="px-4">
        <LoadFailed
          title={t("overview.loadFailed")}
          onRetry={() => review.refetch()}
          testId="attention-review-error"
        />
      </div>
    );

  return (
    <div
      className="grid gap-4 px-4 pb-6"
      data-testid="attention-review-body"
      data-family-slot="queue"
    >
      {held.map((schedule) => (
        <ScheduleReviewCard key={schedule.id} schedule={schedule} />
      ))}
      {heldHooks.map((hook) => (
        <InboundHookReviewCard key={hook.inbound_hook_id} hook={hook} />
      ))}
      {decisions.map((entry, index) => (
        <DecisionCard
          key={entry.id}
          item={entry}
          index={index}
          testIdPrefix="review-decision"
          names={review.names}
          canReadRuns={review.canReadRuns}
          priority={item?.class === "decide" ? "normal" : "urgent"}
          busy={busyId === entry.id}
          canDecide={entry.kind === "patch" ? canDecidePatches : canDecideSkills}
          onApprove={(target, reviewDigest) =>
            decide.mutate({ item: target, approve: true, reason: "", reviewDigest })
          }
          onReject={(target, reason) => decide.mutate({ item: target, approve: false, reason })}
        />
      ))}
      {decisions.length === 0 && held.length === 0 && heldHooks.length === 0 ? (
        <div className="grid gap-3" data-testid="attention-review-empty">
          {elsewhere ?? (
            <p className="text-sm text-muted-foreground">{t("overview.sheet.nothingOpen")}</p>
          )}
          {back}
        </div>
      ) : null}
    </div>
  );
}
