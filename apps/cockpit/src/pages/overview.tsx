import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import { useSetup } from "@/api/setup";
import { markAttentionSeen } from "@/app/attention-seen";
import {
  absolute,
  attentionHref,
  auditHref,
  chatNewHref,
  connectorHref,
  conversationHref,
  reviewFromUrl,
  routerTarget,
  runHref,
  workflowHref,
} from "@/app/links";
import { visibleNavigation } from "@/app/navigation";
import { useSession, useSessionUpdate } from "@/app/session";
import { hideAttentionEntry, restoreAttentionEntry, useAttention } from "@/app/use-attention";
import { useReviewDecisions } from "@/app/use-decisions";
import {
  ActionButton,
  ActionMenu,
  DataState,
  Page,
  PageHeader,
  RecordSheet,
  RowsSkeleton,
  Section,
  SegmentedControl,
  SummaryLine,
  SummaryParts,
  TileSkeleton,
} from "@/components/cockpit/patterns";
import { ForbiddenState } from "@/components/failure-state";
import { connectorSignIn, signInFailure } from "@/features/connectors";
import type { DecisionItem } from "@/features/decisions";
import { DecisionCard, InboundHookReviewCard } from "@/features/decisions";
import { FirstSteps } from "@/features/first-steps";
import { AutomationGrant } from "@/features/grants";
import {
  isLiveRun,
  kpiCards,
  NeedRow,
  NeedsAllClear,
  OverviewKpis,
  RepairRequiredHint,
  RunRow,
  runTone,
  useOperationsFigures,
  useRepairRequiredCount,
} from "@/features/operations";
import {
  type AttentionAction,
  type AttentionItem,
  actionLabelKey,
  attentionDetail,
  attentionEnvironment,
  attentionReason,
  attentionRow,
  attentionSentence,
  attentionTarget,
  entryActions,
  opensReviewSheet,
  overviewView,
  type ReviewAccess,
  reviewForward,
  reviewNavigation,
  reviewSettles,
  reviewTarget,
  signsInFromRow,
  sinceLabel,
  sourceLabel,
  startSteps,
  WaitingOnLine,
} from "@/features/overview";
import { isExecutionRecord, latestFailedRun, runName } from "@/features/runs";
import { personalStartSteps } from "@/features/setup";
import {
  type OperatingFigureId,
  STATS_WINDOWS,
  type StatsWindow,
  type WindowBounds,
  windowBounds,
} from "@/features/usage/model";
import { EnvironmentChip, ScheduleReviewCard, useOpenRunSheet } from "@/features/workflows";
import { reportFailure } from "@/lib/action-failure";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { EngineWording } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";

type ExecutionListItem = components["schemas"]["ExecutionListItem"];

const KPI_IDS = ["runs", "successRate", "connectorHealth", "budget"] as const;

function AttentionEnvironment({ item, index }: { item: AttentionItem; index: number }) {
  const environment = attentionEnvironment(item);
  return environment ? (
    <EnvironmentChip environment={environment} testId={`attention-item-${index}-environment`} />
  ) : null;
}

function AttentionDetail({ item }: { item: AttentionItem }) {
  const { t } = useI18n();
  const detail = attentionDetail(item, t);
  if (!detail) return null;
  return detail.source === "engine" ? (
    <EngineWording text={detail.text} testId="attention-review-detail" />
  ) : (
    <span
      className="mt-1 block text-xs font-normal text-muted-foreground"
      data-testid="attention-review-detail"
    >
      {detail.text}
    </span>
  );
}

function subjectHref(item: AttentionItem): string | null {
  if (!item.subject) return null;
  if (item.subject.kind === "workflow") return workflowHref(item.subject.id);
  if (item.subject.kind === "connector") return connectorHref(item.subject.id);
  if (item.subject.kind === "conversation") return conversationHref(item.subject.id);
  return null;
}

function CompletingVerb({
  item,
  index,
  permissions,
  onReview,
}: {
  item: AttentionItem;
  index: number;
  permissions: readonly string[];
  onReview: (id: string) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sheets = useOpenRunSheet();
  const { primary } = entryActions(item);
  const testId = `attention-item-${index}-primary`;
  const signIn = useMutation({
    mutationFn: async (): Promise<{ authorization_url: string } | null> => {
      const subject = item.subject;
      if (subject?.kind === "connection")
        return apiCall("post", "/v1/connections/{id}/renew", { path: { id: subject.id } });
      if (subject?.kind !== "connector") return null;
      const route = connectorSignIn(
        await apiCall("get", "/v1/connectors/{id}", { path: { id: subject.id } }),
      );
      if (!route) return null;
      return route.kind === "mcp"
        ? apiCall("post", "/v1/connectors/{id}/mcp/authorize", { path: { id: subject.id } })
        : apiCall("post", "/v1/connectors/{id}/oauth/start", { path: { id: subject.id } });
    },
    onSuccess: (result) => {
      if (result?.authorization_url) window.location.assign(result.authorization_url);
      else if (primary) void navigate(routerTarget(primary.href));
    },
    onError: (failure) => {
      reportFailure(signInFailure(failure, t), failure);
      if (primary) void navigate(routerTarget(primary.href));
    },
  });
  const cause = useMutation({
    mutationFn: () =>
      apiCall("get", "/v1/executions", {
        query: { workflow_id: item.subject?.id ?? "", limit: 20 },
      }),
    onSuccess: (list) => {
      const failed = latestFailedRun((list.items ?? []).filter(isExecutionRecord));
      if (failed) sheets.run(failed.id);
      else if (primary) void navigate(routerTarget(primary.href));
    },
    onError: () => primary && void navigate(routerTarget(primary.href)),
  });
  if (!primary) return null;
  const allowed = permissions.includes(primary.permission);
  const data = { "data-attention-verb": primary.verb } as const;
  if (!allowed)
    return (
      <ActionButton size="sm" disabled testId={testId} data={data}>
        {t(actionLabelKey(primary, item))}
      </ActionButton>
    );
  if (item.reason === "version_awaiting_approval" && item.subject?.kind === "workflow")
    return (
      <AutomationGrant
        workflowId={item.subject.id}
        environment={item.approval?.environment ?? "prod"}
        testId={testId}
        triggerLabel={t("overview.action.approveDialog")}
        triggerVariant="outline"
      />
    );
  if (opensReviewSheet(item, primary))
    return (
      <ActionButton size="sm" onClick={() => onReview(item.id)} testId={testId} data={data}>
        {t("overview.action.check")}
      </ActionButton>
    );
  if (signsInFromRow(primary, item))
    return (
      <ActionButton
        size="sm"
        pending={signIn.isPending}
        onClick={() => signIn.mutate()}
        testId={testId}
        data={data}
      >
        {t("connectorCredentials.renew")}
      </ActionButton>
    );
  if (item.reason === "failing" && item.subject?.kind === "workflow")
    return (
      <ActionButton
        size="sm"
        pending={cause.isPending}
        onClick={() => cause.mutate()}
        testId={testId}
        data={data}
      >
        {t("overview.action.cause")}
      </ActionButton>
    );
  return (
    <ActionButton
      size="sm"
      onClick={() => void navigate(routerTarget(attentionTarget(primary, item)))}
      testId={testId}
      data={data}
    >
      {t(actionLabelKey(primary, item))}
    </ActionButton>
  );
}

function NeedsYou({
  items,
  emptyLine,
  allClear,
  pending,
  error,
  permissions,
  onReview,
}: {
  items: AttentionItem[];
  emptyLine: string;
  allClear: boolean;
  pending: boolean;
  error: { line: string; onRetry(): void } | null;
  permissions: readonly string[];
  onReview: (id: string) => void;
}) {
  const { t } = useI18n();
  const now = useMemo(() => Date.now(), []);
  if (pending) return <RowsSkeleton count={3} testId="attention-list-loading" />;
  if (error)
    return (
      <DataState state="error" line={error.line} onRetry={error.onRetry} testId="attention-error" />
    );
  if (items.length === 0)
    return allClear ? (
      <NeedsAllClear />
    ) : (
      <DataState state="empty" line={emptyLine} testId="attention-empty" />
    );
  return (
    <ul
      className="flex flex-col gap-2"
      data-testid="attention-list"
      data-family-slot="attention-list"
    >
      {items.map((item, index) => {
        const row = attentionRow(item, t);
        const href = subjectHref(item);
        const since = sinceLabel(item.since, now, t);
        return (
          <NeedRow
            key={item.id}
            reason={attentionReason(item)}
            state={t(row.badge.label)}
            testId={`attention-item-${index}`}
            title={
              <>
                {href ? (
                  <a
                    href={absolute(href)}
                    className="underline-offset-4 hover:underline"
                    aria-label={sentenceLabel(item, t, now)}
                    data-testid={`attention-item-${index}-open`}
                  >
                    {row.name}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="text-left underline-offset-4 hover:underline"
                    onClick={() => onReview(item.id)}
                    aria-label={sentenceLabel(item, t, now)}
                    data-testid={`attention-item-${index}-open`}
                  >
                    {row.name}
                  </button>
                )}
                <AttentionEnvironment item={item} index={index} />
              </>
            }
            hint={
              <>
                <span data-testid={`attention-item-${index}-text`}>
                  {row.reason}
                  {row.machine ? (
                    <code className="ml-1 font-mono text-xs" data-machine-value="true">
                      {row.machine}
                    </code>
                  ) : null}
                  {since ? ` · ${since}` : null}
                </span>
                {item.waiting_on?.name ? (
                  <WaitingOnLine
                    name={item.waiting_on.name}
                    testId={`attention-item-${index}-waiting-on`}
                  />
                ) : null}
              </>
            }
            action={
              <span data-action-scope="attention" data-attention-id={item.id}>
                <CompletingVerb
                  item={item}
                  index={index}
                  permissions={permissions}
                  onReview={onReview}
                />
              </span>
            }
          />
        );
      })}
    </ul>
  );
}

function StartSteps() {
  const { t } = useI18n();
  const session = useSession();
  const setup = useSetup().data;
  const update = useSessionUpdate();
  const hide = useMutation({
    mutationFn: () => apiCall("patch", "/v1/identity/me", { body: { start_steps_hidden: true } }),
    onMutate: () =>
      update.patch((current) => ({
        ...current,
        start_steps: { ...current.start_steps, hidden: true },
      })),
    onError: () => {
      update.patch((current) => ({
        ...current,
        start_steps: { ...current.start_steps, hidden: false },
      }));
      reportFailure(t("common.actionFailed"));
    },
  });
  return (
    <FirstSteps
      steps={personalStartSteps(
        startSteps(session).map((step) => ({
          id: step.id,
          title: t(step.title),
          line: t(step.line),
          href: step.href,
          done: step.done,
        })),
        setup,
        t,
        (prompt) =>
          session.permissions.includes("conversation:write") ? chatNewHref({ prompt }) : null,
      )}
      hidden={session.start_steps.hidden}
      onHide={() => hide.mutate()}
    />
  );
}

function sentenceLabel(
  item: AttentionItem,
  t: ReturnType<typeof useI18n>["t"],
  now: number,
): string {
  const { lead, since } = attentionSentence(item, t, now);
  return `${lead}${since ? ` — ${since}` : ""}.`;
}

const RECENT_RUNS = 5;

function RecentRuns() {
  const { t, dateTime } = useI18n();
  const sheets = useOpenRunSheet();
  const query = useQuery({
    queryKey: ["runs", "overview-recent"],
    queryFn: () => apiCall("get", "/v1/executions", { query: { limit: RECENT_RUNS } }),
  });
  const rows = (query.data?.items ?? []).filter((item): item is ExecutionListItem =>
    isExecutionRecord(item),
  );
  if (query.isPending) return <RowsSkeleton count={RECENT_RUNS} testId="overview-recent-loading" />;
  if (query.error)
    return (
      <DataState
        state="error"
        line={t("runs.detail.loadFailed")}
        error={query.error}
        onRetry={() => void query.refetch()}
        testId="overview-recent-error"
      />
    );
  if (rows.length === 0)
    return <DataState state="empty" line={t("ops.recent.empty")} testId="overview-recent-empty" />;
  return (
    <ul className="divide-y rounded-xl border" data-testid="overview-recent">
      {rows.map((run) => (
        <RunRow
          key={run.id}
          tone={runTone(run.status)}
          pulse={isLiveRun(run.status)}
          name={runName(run, t)}
          outcome={statusLabel(t, run.status)}
          time={dateTime(run.started_at ?? run.created_at)}
          href={absolute(runHref(run.id))}
          onOpen={() => sheets.run(run.id)}
          testId={`overview-recent-${run.id}`}
        />
      ))}
    </ul>
  );
}

export function OverviewPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const attention = useAttention(session.permissions);
  const sheets = useOpenRunSheet();
  const [bounds, setBounds] = useState<WindowBounds>(() => windowBounds("24h"));
  const operations = useOperationsFigures(bounds, session.permissions);
  const repairRequired = useRepairRequiredCount(session.permissions);
  const href = useRouterState({ select: (state) => state.location.href });
  const [review, setReview] = useState<string | null>(() => reviewFromUrl(window.location.search));
  const seenAttention =
    attention.enabled && !attention.query.isError ? attention.query.data : undefined;
  useEffect(() => {
    if (!seenAttention) return;
    const mark = () => {
      if (document.visibilityState === "visible") markAttentionSeen(session, seenAttention);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [seenAttention, session]);

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
  const closeReview = useCallback(() => {
    navigation.close();
    setReview(null);
  }, [navigation]);

  const fallback = attention.enabled
    ? null
    : (visibleNavigation(session.permissions)
        .flatMap((group) => group.items)
        .find((item) => item.path !== "/")?.path ?? null);
  useEffect(() => {
    if (fallback) window.location.replace(absolute(fallback));
  }, [fallback]);

  const title = t("overview.title");
  if (!attention.enabled)
    return fallback ? (
      <main className="p-6" aria-busy="true" data-testid="attention-redirect" />
    ) : (
      <Page
        kind="list"
        scroll="page"
        testId="resource-permission-denied"
        header={<PageHeader title={title} />}
      >
        <ForbiddenState />
      </Page>
    );

  const data = attention.query.data;
  const view = data ? overviewView(data, attention.hidden) : null;
  const items = view?.kind === "items" ? view.items : [];
  const unread = view && (view.kind === "items" || view.kind === "unread") ? view.unread : [];
  const reviewed = review ? (data?.items.find((item) => item.id === review) ?? null) : null;
  const canHistory = session.permissions.includes("audit:read");
  const canRuns = session.permissions.includes("execution:read");
  const count = items.length;
  const summary =
    attention.query.isPending || attention.query.isError || unread.length > 0
      ? null
      : t(count === 1 ? "overview.count.one" : "overview.count.other", { count });

  return (
    <Page
      kind="list"
      surface="overview"
      testId="attention-page"
      scroll="page"
      header={
        <PageHeader
          title={title}
          secondary={
            canRuns ? (
              <ActionButton onClick={sheets.all} testId="overview-all-runs">
                {t("overview.allRuns")}
              </ActionButton>
            ) : undefined
          }
          menu={
            canHistory ? (
              <ActionMenu
                items={[
                  {
                    label: t("overview.history.link"),
                    href: absolute(auditHref({ scope: "decisions" })),
                    testId: "attention-history",
                  },
                ]}
              />
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <SummaryLine
            text={
              <SummaryParts
                parts={[
                  summary,
                  repairRequired && repairRequired > 0 ? (
                    <RepairRequiredHint key="repair" count={repairRequired} />
                  ) : null,
                ]}
              />
            }
            helpLabel={summary ?? undefined}
            help={summary && operations.allowed ? t("overview.countHelp") : undefined}
            testId="overview-summary"
            aside={
              operations.allowed ? (
                <SegmentedControl
                  label={t("overview.window")}
                  value={bounds.window}
                  onValueChange={(next) => setBounds(windowBounds(next as StatsWindow))}
                  testId="operations-window"
                  options={STATS_WINDOWS.map((window) => ({
                    value: window,
                    label: t(`overview.operations.windowOption.${window}` as TranslationKey),
                    testId: `operations-window-${window}`,
                  }))}
                />
              ) : undefined
            }
          />
          {operations.allowed ? (
            operations.pending ? (
              <div className="@container">
                <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
                  {KPI_IDS.map((id) => (
                    <TileSkeleton key={id} />
                  ))}
                </div>
              </div>
            ) : (
              <OverviewKpis
                cards={kpiCards(
                  operations.figures.filter((figure) =>
                    (KPI_IDS as readonly string[]).includes(figure.id),
                  ),
                  operations.visuals,
                  t,
                  locale,
                  bounds.window,
                ).map((card) => ({
                  ...card,
                  href: card.href ? absolute(card.href) : null,
                  link: card.link ? { ...card.link, href: absolute(card.link.href) } : null,
                }))}
                onRetry={(id) => operations.retry(id as OperatingFigureId)}
              />
            )
          ) : null}
        </div>
        {unread.length > 0 ? (
          <DataState
            state="error"
            line={t("overview.unread.description", {
              sources: unread.map((source) => sourceLabel(source, t)).join(", "),
            })}
            onRetry={() => void attention.query.refetch()}
            testId="attention-unread"
          />
        ) : null}
        <StartSteps />
        <div data-action-scope="list">
          <Section label={t("overview.needsYou")} testId="attention-section">
            {view?.kind === "nothing_readable" ? (
              <ForbiddenState />
            ) : (
              <NeedsYou
                items={items}
                emptyLine={t(unread.length > 0 ? "overview.count.noneRead" : "overview.count.none")}
                allClear={unread.length === 0}
                pending={attention.query.isPending}
                error={
                  attention.query.isError
                    ? {
                        line: t("overview.loadFailed"),
                        onRetry: () => void attention.query.refetch(),
                      }
                    : null
                }
                permissions={session.permissions}
                onReview={openReview}
              />
            )}
          </Section>
        </div>
        {canRuns && !attention.query.isPending ? (
          <div data-action-scope="list">
            <Section label={t("ops.recent.title")} testId="overview-recent-section">
              <RecentRuns />
            </Section>
          </div>
        ) : null}
      </div>
      <ReviewSheet id={review} item={reviewed} onClose={closeReview} />
    </Page>
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

function ReviewSheet({
  id,
  item,
  onClose,
}: {
  id: string | null;
  item: AttentionItem | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  return (
    <RecordSheet
      open={Boolean(id)}
      onOpenChange={(open) => !open && onClose()}
      title={
        item
          ? item.subject?.kind === "workflow"
            ? attentionRow(item, t).reason
            : attentionRow(item, t).name
          : t("overview.sheet.title")
      }
      subtitle={
        item?.subject?.kind === "workflow" && item.subject.name ? (
          <a href={absolute(workflowHref(item.subject.id))} data-testid="attention-review-workflow">
            {item.subject.name}
          </a>
        ) : undefined
      }
      action={
        <span
          ref={setActionsSlot}
          className="flex items-center gap-2 empty:hidden"
          data-testid="attention-review-actions"
        />
      }
      titleTestId="attention-review-title"
      testId="attention-review"
      closeTestId="attention-review-close"
    >
      {item && item.subject?.kind !== "workflow" ? (
        <SummaryLine text={attentionRow(item, t).reason} testId="attention-review-reason" />
      ) : null}
      {item ? <AttentionDetail item={item} /> : null}
      {id ? (
        <ReviewBody key={id} id={id} item={item} onClose={onClose} actionsSlot={actionsSlot} />
      ) : null}
    </RecordSheet>
  );
}

function ReviewBody({
  id,
  item,
  onClose,
  actionsSlot,
}: {
  id: string;
  item: AttentionItem | null;
  onClose: () => void;
  actionsSlot: HTMLElement | null;
}) {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const target = reviewTarget(id);
  const review = useReviewDecisions(target, session.permissions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canDecidePatches = session.permissions.includes("workflow:write");
  const canDecideSkills =
    session.permissions.includes("skill:write") && session.permissions.includes("skill:activate");
  const { decisions, held, heldHooks } = review;
  const closed = useRef(false);
  const closeOnce = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);
  const openCount = decisions.length + held.length + heldHooks.length;
  const loaded = review.access === "readable" && !review.isPending && !review.failed;
  const listed = item !== null;
  const seen = useRef<{ open: number | null; listed: boolean }>({ open: null, listed: false });
  useEffect(() => {
    const before = seen.current;
    seen.current = { open: loaded ? openCount : before.open, listed: before.listed || listed };
    if (
      reviewSettles({
        openBefore: before.open,
        openNow: loaded ? openCount : 0,
        listedBefore: before.listed,
        listedNow: listed,
      }) &&
      (loaded || !listed)
    )
      closeOnce();
  }, [loaded, openCount, listed, closeOnce]);

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
      const remaining = decisions.filter((entry) => entry.id !== input.item.id).length;
      const settles = remaining === 0 && held.length === 0 && heldHooks.length === 0;
      if (settles && item) hideAttentionEntry(item);
      return { settles };
    },
    onSuccess: async (_result, input, context) => {
      if (context?.settles) closeOnce();
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
      reportFailure(t(decisionFailureKey(error)), error);
      void queryClient.invalidateQueries({ queryKey: ["decisions"] });
      void queryClient.invalidateQueries({ queryKey: ["attention"] });
      void queryClient.invalidateQueries({ queryKey: ["patch-candidate"] });
    },
    onSettled: () => setBusyId(null),
  });

  const { primary } = item ? entryActions(item) : { primary: null as AttentionAction | null };
  const forward = (access: ReviewAccess) => {
    const action = reviewForward(primary, access);
    return item && action ? (
      <ActionButton
        onClick={() => void navigate(routerTarget(action.href))}
        testId="attention-review-action"
      >
        {t(actionLabelKey(action, item))}
      </ActionButton>
    ) : null;
  };

  if (review.access !== "readable")
    return (
      <div className="flex flex-col items-start gap-3" data-testid="attention-review-body">
        <DataState
          state="empty"
          line={t(
            review.access === "not_permitted"
              ? "overview.sheet.notPermitted"
              : "overview.sheet.nothingToReview",
          )}
          testId={
            review.access === "not_permitted"
              ? "attention-review-not-permitted"
              : "attention-review-nothing"
          }
          action={forward(review.access)}
        />
      </div>
    );
  if (review.isPending && !review.failed) return <RowsSkeleton count={2} />;
  if (review.failed)
    return (
      <DataState
        state="error"
        line={t("overview.loadFailed")}
        onRetry={() => review.refetch()}
        testId="attention-review-error"
      />
    );

  return (
    <div
      className="flex flex-col gap-4"
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
          permissions={session.permissions}
          onDecided={() => {
            for (const queryKey of [["decisions"], ["attention"], ["skill-candidates"]])
              void queryClient.invalidateQueries({ queryKey });
          }}
          actionsSlot={
            decisions.length === 1 && held.length === 0 && heldHooks.length === 0
              ? actionsSlot
              : null
          }
        />
      ))}
      {decisions.length === 0 && held.length === 0 && heldHooks.length === 0 ? (
        <DataState
          state="empty"
          line={t("overview.sheet.nothingOpen")}
          testId="attention-review-empty"
          action={forward(review.access)}
        />
      ) : null}
    </div>
  );
}
