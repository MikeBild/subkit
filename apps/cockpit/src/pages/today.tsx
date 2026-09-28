import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import { absolute, attentionHref, auditHref, reviewFromUrl, routerPath } from "@/app/links";
import { visibleNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { hideAttentionEntry, restoreAttentionEntry, useAttention } from "@/app/use-attention";
import { useDecisionQueue } from "@/app/use-decisions";
import { DecisionCard } from "@/components/cockpit/decision-card";
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
import {
  type DecidableItem,
  type DecisionItem,
  decisionWorkflowId,
  isDecidable,
} from "./decisions-model";
import {
  type AttentionAction,
  type AttentionItem,
  type AttentionSentence,
  actionLabelKey,
  attentionSentence,
  entryActions,
  reviewTarget,
  sourceLabel,
  statusLine,
  todayView,
} from "./today-model";

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
 * Heute: what needs the reader now, one entry per subject, each with one way
 * to act on it. Tasks live here and nowhere else — the object pages show their
 * state and at most link here.
 */
export function TodayPage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const attention = useAttention(session.permissions);
  const href = useRouterState({ select: (state) => state.location.href });
  const [review, setReview] = useState<string | null>(() => reviewFromUrl(window.location.search));

  // The sheet follows the address: Back closes it, a link opens it, and a
  // router navigation to Heute (the sidebar entry) lands without it.
  useEffect(() => {
    void href;
    setReview(reviewFromUrl(window.location.search));
  }, [href]);
  useEffect(() => {
    const onPopState = () => setReview(reviewFromUrl(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const openReview = useCallback((id: string | null) => {
    window.history.pushState({}, "", absolute(attentionHref({ review: id })));
    setReview(id);
  }, []);

  // Nobody reads Heute who may read none of its sources: they land on the
  // first page they can see, not on a page that can only ever be empty.
  const fallback = attention.enabled
    ? null
    : (visibleNavigation(session.permissions)
        .flatMap((group) => group.items)
        .find((item) => item.path !== "/")?.path ?? null);
  useEffect(() => {
    if (fallback) window.location.replace(absolute(fallback));
  }, [fallback]);

  const title = t("today.title");
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
  const view = data ? todayView(data, attention.hidden) : null;
  const now = Date.now();
  const reviewed = review ? (data?.items.find((item) => item.id === review) ?? null) : null;

  return (
    <PageFrame
      surface="overview"
      testId="attention-page"
      title={title}
      scroll="page"
      width="column"
    >
      <div className="grid gap-6">
        {attention.query.isPending ? (
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
        ) : attention.query.isError || !view ? (
          <LoadFailed
            title={t("today.loadFailed")}
            onRetry={() => void attention.query.refetch()}
            testId="attention-error"
          />
        ) : view.kind === "calm" ? (
          <CalmState line={statusLine(view.status, t, dateTime)} />
        ) : view.kind === "nothing_readable" ? (
          <Alert data-testid="resource-permission-alert">
            <AlertTitle>{t("resource.permission.title")}</AlertTitle>
            <AlertDescription>{t("resource.permission.description")}</AlertDescription>
          </Alert>
        ) : (
          <>
            {view.kind === "items" ? (
              <ol className="grid gap-2" data-testid="attention-list" data-family-slot="queue">
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
            ) : null}
            <UnreadSources sources={view.unread} onRetry={() => void attention.query.refetch()} />
          </>
        )}
        {session.permissions.includes("audit:read") ? (
          <p className="text-sm text-muted-foreground" data-testid="attention-history">
            <Link
              to={auditHref({ scope: "decisions" })}
              className="underline underline-offset-2"
              data-testid="attention-history-link"
            >
              {t("today.history.link")}
            </Link>
          </p>
        ) : null}
      </div>
      <ReviewSheet id={review} item={reviewed} now={now} onClose={() => openReview(null)} />
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
        {t("today.calm")}
      </p>
      {line ? (
        <p className="text-sm text-muted-foreground" data-testid="attention-status">
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
      title={t("today.unread.title")}
      description={t("today.unread.description", {
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
        title={t("today.notPermitted")}
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
  return (
    <Button size="sm" variant={variant === "primary" ? "default" : "link"} asChild>
      <Link to={path} data-testid={testId} data-attention-verb={action.verb}>
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
 * One entry's decisions, in a sheet over Heute.
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
        aria-describedby={undefined}
      >
        <SheetHeader>
          <SheetTitle data-testid="attention-review-title" className="pr-8">
            {item ? (
              <SentenceText sentence={attentionSentence(item, t, now)} />
            ) : (
              t("today.sheet.title")
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
  const queue = useDecisionQueue(session.permissions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const target = reviewTarget(id);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills =
    session.permissions.includes("skill:write") && session.permissions.includes("skill:activate");

  const decidable = queue.items.filter(isDecidable) as DecidableItem[];
  const decisions =
    target.kind === "workflow"
      ? decidable.filter(
          (entry) => entry.kind === "patch" && decisionWorkflowId(entry) === target.workflowId,
        )
      : target.kind === "skills"
        ? decidable.filter((entry) => entry.kind === "skill")
        : [];
  const held =
    target.kind === "workflow"
      ? queue.heldSchedules.filter((schedule) => schedule.workflow_id === target.workflowId)
      : [];

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
      const settles = remaining === 0 && held.length === 0;
      if (settles) hideAttentionEntry(id);
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
            {t("today.decided.audit")}
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

  if (queue.isPending && !queue.failed)
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
  if (queue.failed)
    return (
      <div className="px-4">
        <LoadFailed
          title={t("today.loadFailed")}
          onRetry={() => queue.refetch()}
          testId="attention-review-error"
        />
      </div>
    );

  const { primary } = item ? entryActions(item) : { primary: null };
  return (
    <div
      className="grid gap-4 px-4 pb-6"
      data-testid="attention-review-body"
      data-family-slot="queue"
    >
      {held.map((schedule) => (
        <ScheduleReviewCard key={schedule.id} schedule={schedule} />
      ))}
      {decisions.map((entry, index) => (
        <DecisionCard
          key={entry.id}
          item={entry}
          index={index}
          testIdPrefix="review-decision"
          names={queue.names}
          canReadRuns={queue.canReadRuns}
          priority={item?.class === "decide" ? "normal" : "urgent"}
          busy={busyId === entry.id}
          canDecide={entry.kind === "patch" ? canDecidePatches : canDecideSkills}
          onApprove={(target, reviewDigest) =>
            decide.mutate({ item: target, approve: true, reason: "", reviewDigest })
          }
          onReject={(target, reason) => decide.mutate({ item: target, approve: false, reason })}
        />
      ))}
      {decisions.length === 0 && held.length === 0 ? (
        <div className="grid gap-3" data-testid="attention-review-empty">
          {item && primary && primary.verb !== "review" ? (
            <Button asChild className="justify-self-start">
              <Link to={routerPath(primary.href)} data-testid="attention-review-action">
                {t(actionLabelKey(primary, item))}
              </Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t("today.sheet.nothingOpen")}</p>
          )}
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={onClose}
            data-testid="attention-review-back"
          >
            {t("today.sheet.close")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
