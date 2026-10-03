import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  approvePatchCandidate,
  approveSkillCandidate,
  rejectPatchCandidate,
  rejectSkillCandidate,
} from "@/api/decisions";
import type { components } from "@/api/schema";
import {
  absolute,
  attentionHref,
  auditHref,
  connectorHref,
  conversationHref,
  reviewFromUrl,
  routerTarget,
  runHref,
  workflowHref,
} from "@/app/links";
import { visibleNavigation } from "@/app/navigation";
import { useSession } from "@/app/session";
import { hideAttentionEntry, restoreAttentionEntry, useAttention } from "@/app/use-attention";
import { useReviewDecisions } from "@/app/use-decisions";
import { AutomationGrant } from "@/components/cockpit/automation-grant";
import { DecisionCard } from "@/components/cockpit/decision-card";
import { InboundHookReviewCard } from "@/components/cockpit/inbound-hook-review-card";
import {
  ActionButton,
  ActionMenu,
  type CockpitColumn,
  DataState,
  Page,
  PageHeader,
  RecordSheet,
  RowsSkeleton,
  Section,
  SegmentedControl,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { ScheduleReviewCard } from "@/components/cockpit/schedule-review-card";
import { tableColumns } from "@/components/cockpit/table-columns";
import { causeClassLabel } from "@/lib/cause-class";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { EngineWording } from "@/lib/machine-label";
import type { DecisionItem } from "./decisions-model";
import { OperationsBar, useOperationsFigures } from "./operations-bar";
import { type StatsWindow, type WindowBounds, windowBounds } from "./operations-figures";
import {
  type AttentionAction,
  type AttentionItem,
  actionLabelKey,
  attentionRow,
  attentionSentence,
  entryActions,
  overviewView,
  reviewNavigation,
  reviewTarget,
  sinceLabel,
  sourceLabel,
} from "./overview-model";
import { isExecutionRecord, latestFailedRun, runName } from "./runs-model";

type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];

/** The four figures the Übersicht leads with (R1); the rest are Nutzung's. */
const KPI_IDS = ["runs", "successRate", "connectorHealth", "budget"] as const;
const WINDOWS: readonly StatsWindow[] = ["24h", "7d"];

/** Where an entry's name leads: its object's own page, else its review. */
function subjectHref(item: AttentionItem): string | null {
  if (!item.subject) return null;
  if (item.subject.kind === "workflow") return workflowHref(item.subject.id);
  if (item.subject.kind === "connector") return connectorHref(item.subject.id);
  if (item.subject.kind === "conversation") return conversationHref(item.subject.id);
  return null;
}

/**
 * The verb that completes an entry (D12): "Freigeben…" opens the approval
 * dialog right here, "Neu anmelden" starts the sign-in, "Ursache ansehen"
 * opens the newest failed run, "Prüfen" opens the review sheet. Every other
 * entry leads where it is acted on.
 */
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
    mutationFn: async () => {
      const subject = item.subject;
      if (subject?.kind === "connection")
        return apiRequest<{ authorization_url: string }>(
          `/v1/connections/${encodeURIComponent(subject.id)}/renew`,
          { method: "POST" },
        );
      return apiRequest<{ authorization_url: string }>(
        `/v1/connectors/${encodeURIComponent(subject?.id ?? "")}/oauth/start`,
        { method: "POST" },
      );
    },
    onSuccess: (result) => window.location.assign(result.authorization_url),
    // Not every sign-in starts at a provider: the connector's page knows the way.
    onError: () => primary && void navigate(routerTarget(primary.href)),
  });
  const cause = useMutation({
    mutationFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?workflow_id=${encodeURIComponent(item.subject?.id ?? "")}&limit=20`,
      ),
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
  if (primary.verb === "review")
    return (
      <ActionButton size="sm" onClick={() => onReview(item.id)} testId={testId} data={data}>
        {t("overview.action.check")}
      </ActionButton>
    );
  if ((primary.verb === "reauth" || primary.verb === "renew") && item.subject)
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
      onClick={() => void navigate(routerTarget(primary.href))}
      testId={testId}
      data={data}
    >
      {t(actionLabelKey(primary, item))}
    </ActionButton>
  );
}

/** "Braucht dich": one row per subject, its name the object alone, its action the verb that completes it. */
function NeedsYou({
  items,
  pending,
  error,
  permissions,
  onReview,
}: {
  items: AttentionItem[];
  pending: boolean;
  error: { line: string; onRetry(): void } | null;
  permissions: readonly string[];
  onReview: (id: string) => void;
}) {
  const { t, dateTime } = useI18n();
  const navigate = useNavigate();
  const now = useMemo(() => Date.now(), []);
  const columns = useMemo<CockpitColumn<AttentionItem>[]>(() => {
    const column = tableColumns<AttentionItem>({ t, dateTime });
    return [
      column.custom(
        "name",
        (item) => attentionRow(item, t).name,
        t("overview.column.entry"),
        (item) => <span className="font-medium">{attentionRow(item, t).name}</span>,
        { width: "w-[30%]" },
      ),
      column.custom(
        "reason",
        (item) => item.reason,
        t("overview.column.reason"),
        (item, index) => {
          const row = attentionRow(item, t);
          return (
            <span className="text-muted-foreground" data-testid={`attention-item-${index}-text`}>
              {row.reason}
              {row.machine ? (
                <code className="ml-1 font-mono text-xs" data-machine-value="true">
                  {row.machine}
                </code>
              ) : null}
            </span>
          );
        },
        { width: "w-[34%]" },
      ),
      column.custom(
        "state",
        (item) => item.reason,
        t("resource.field.status"),
        (item) => {
          const { badge } = attentionRow(item, t);
          return <StatusBadge state={badge.state} label={t(badge.label)} />;
        },
        { width: "w-[20%]" },
      ),
      column.custom(
        "since",
        (item) => item.since,
        t("overview.column.when"),
        (item) => sinceLabel(item.since, now, t) ?? "—",
        { width: "w-[16%]" },
      ),
    ];
  }, [t, dateTime, now]);
  return (
    <div data-testid="attention-list" data-family-slot="attention-list">
      <RecordTable
        columns={columns}
        data={items}
        collectionId="attention"
        emptyLine={t("overview.count.none")}
        pending={pending}
        error={error}
        getRowId={(item) => item.id}
        onOpen={(item) => {
          const href = subjectHref(item);
          if (href) void navigate({ to: href });
          else onReview(item.id);
        }}
        rowHref={(item) => subjectHref(item)}
        rowLabel={(item) => sentenceLabel(item, t, now)}
        rowActions={(item, index) => (
          <span data-action-scope="attention" data-attention-id={item.id}>
            <CompletingVerb
              item={item}
              index={index}
              permissions={permissions}
              onReview={onReview}
            />
          </span>
        )}
      />
    </div>
  );
}

function sentenceLabel(
  item: AttentionItem,
  t: ReturnType<typeof useI18n>["t"],
  now: number,
): string {
  return attentionSentence(item, t, now).lead;
}

/** "Letzte Fehlschläge": the newest three failed runs, each opening its sheet here. */
function LastFailures() {
  const { t, dateTime } = useI18n();
  const sheets = useOpenRunSheet();
  const query = useQuery({
    queryKey: ["runs", "overview-failures"],
    queryFn: () => apiRequest<ExecutionList>("/v1/executions?status=failed&limit=3"),
  });
  const rows = (query.data?.items ?? []).filter((item): item is ExecutionListItem =>
    isExecutionRecord(item),
  );
  const columns = useMemo<CockpitColumn<ExecutionListItem>[]>(() => {
    const column = tableColumns<ExecutionListItem>({ t, dateTime });
    return [
      column.custom(
        "run",
        (run) => run.id,
        t("overview.column.run"),
        (run) => <span className="font-medium">{runName(run, t)}</span>,
        { width: "w-[40%]" },
      ),
      column.custom(
        "cause",
        (run) => run.failure?.cause_class ?? null,
        t("overview.column.cause"),
        (run) =>
          run.failure?.cause_class && run.failure.cause_class !== "ok"
            ? causeClassLabel(run.failure.cause_class, t).text
            : "—",
        { width: "w-[35%]" },
      ),
      column.date(
        "started_at",
        (run) => run.started_at ?? run.created_at,
        t("runs.column.started"),
        {
          width: "w-[25%]",
        },
      ),
    ];
  }, [t, dateTime]);
  return (
    <div data-testid="overview-failures">
      <RecordTable
        columns={columns}
        data={rows}
        collectionId="overview-failures"
        emptyLine={t("overview.noFailures")}
        pending={query.isPending}
        error={
          query.error
            ? { line: t("runs.detail.loadFailed"), onRetry: () => void query.refetch() }
            : null
        }
        getRowId={(run) => run.id}
        onOpen={(run) => sheets.run(run.id)}
        rowHref={(run) => runHref(run.id)}
      />
    </div>
  );
}

/**
 * Übersicht (V1): one count of what needs the reader, the four figures over
 * one window (R1), "Braucht dich" with the verb that completes each entry, and
 * the newest failures. Tasks live here and nowhere else — the object pages
 * show their state and at most link here.
 */
export function OverviewPage() {
  const { t } = useI18n();
  const session = useSession();
  const attention = useAttention(session.permissions);
  const sheets = useOpenRunSheet();
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

  // Nobody reads the Übersicht who may read none of its sources: they land on
  // the first page they can see, not on a page that can only ever be empty.
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
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
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
  const summary = attention.query.isPending
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
                    label: t("overview.decided"),
                    href: absolute(auditHref({ scope: "decisions" })),
                    testId: "attention-history-link",
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
            text={summary ?? ""}
            help={operations.allowed ? t("overview.countHelp") : undefined}
            testId="overview-summary"
            aside={
              operations.allowed ? (
                <SegmentedControl
                  label={t("overview.window")}
                  value={bounds.window}
                  onValueChange={(next) => setBounds(windowBounds(next as StatsWindow))}
                  testId="operations-window"
                  options={WINDOWS.map((window) => ({
                    value: window,
                    label: t(`overview.operations.windowOption.${window}` as TranslationKey),
                    testId: `operations-window-${window}`,
                  }))}
                />
              ) : undefined
            }
          />
          {operations.allowed ? (
            <OperationsBar
              figures={operations.figures.filter((figure) =>
                (KPI_IDS as readonly string[]).includes(figure.id),
              )}
              ids={KPI_IDS}
              pending={operations.pending}
              onRetry={operations.retry}
            />
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
        {/* Each list is its own item: its column choice belongs to it alone. */}
        <div data-action-scope="list">
          <Section label={t("overview.needsYou")} testId="attention-section">
            {view?.kind === "nothing_readable" ? (
              <DataState
                state="empty"
                line={t("resource.permission.description")}
                testId="resource-permission-alert"
              />
            ) : (
              <NeedsYou
                items={items}
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
        {canRuns ? (
          <div data-action-scope="list">
            <Section label={t("overview.lastFailures")} testId="overview-failures-section">
              <LastFailures />
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

/**
 * One entry's decisions (O1), in a sheet over the Übersicht: the cards the
 * decisions queue always used — the same diff, dry run, approve and reject —
 * narrowed to this entry's subject. The engine's own wording about the entry
 * is shown here, and only here, marked as the engine's.
 */
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
  return (
    <RecordSheet
      open={Boolean(id)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? attentionRow(item, t).name : t("overview.sheet.title")}
      titleTestId="attention-review-title"
      testId="attention-review"
      closeTestId="attention-review-close"
    >
      {item ? (
        <SummaryLine text={attentionRow(item, t).reason} testId="attention-review-reason" />
      ) : null}
      {item?.detail ? <EngineWording text={item.detail} testId="attention-review-detail" /> : null}
      {id ? <ReviewBody id={id} item={item} onClose={onClose} /> : null}
    </RecordSheet>
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
  const navigate = useNavigate();
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

  const { primary } = item ? entryActions(item) : { primary: null as AttentionAction | null };
  // Where the entry is acted on, when not in this sheet.
  const elsewhere =
    item && primary && primary.verb !== "review" ? (
      <ActionButton
        onClick={() => void navigate(routerTarget(primary.href))}
        testId="attention-review-action"
      >
        {t(actionLabelKey(primary, item))}
      </ActionButton>
    ) : null;

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
          action={elsewhere}
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
        />
      ))}
      {decisions.length === 0 && held.length === 0 && heldHooks.length === 0 ? (
        <DataState
          state="empty"
          line={t("overview.sheet.nothingOpen")}
          testId="attention-review-empty"
          action={elsewhere}
        />
      ) : null}
    </div>
  );
}
