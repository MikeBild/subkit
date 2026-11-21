import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { CircleExclamationPoint, Gauge, MessageSquare, TrendingUp, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { actorKey } from "@/app/actor-directory-model";
import { absolute, chatNewHref, routerTarget, taskHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import {
  ActionButton,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  ContextHelp,
  DataTable,
  FactList,
  GroupingChoice,
  IconTile,
  KpiTile,
  renderAction,
  Section,
  SectionHeading,
  SegmentedControl,
  Skeleton,
  SummaryLine,
  TileSkeleton,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { usePromptCacheFlows } from "@/lib/operating-figures-query";
import {
  llmStatsEndpoint,
  llmStatsQuery,
  previousBounds,
  STATS_WINDOWS,
  type StatsWindow,
  type TimeSpan,
  type WindowBounds,
  windowBucket,
  windowStatsQuery,
} from "@/lib/operations-figures";
import { taskKeys } from "@/lib/task-keys";
import {
  BREAKDOWN_AXIS,
  type BreakdownDim,
  type BreakdownRemainder,
  type BreakdownRow,
  type BudgetForecast,
  type BudgetSummary,
  breakdown,
  breakdownDims,
  type ConsumptionAxis,
  isBreakdownDim,
  llmGroups,
  llmWindow,
  mainDriver,
  originChart,
  originRows,
  runsByWorkflow,
  trendOf,
  type UsageHint,
  type UsageSheet,
  unpricedModels,
  usageHints,
  usageSheetFromSearch,
  usageSheetSearch,
  type WorkflowNameLookup,
  type WorkflowRunCost,
  workflowNameLookup,
} from "@/lib/usage-model";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { OriginChartSvg, OriginChartTable, OriginLegend } from "./chart";
import { PRICE_SETTING, PriceDialog } from "./dialogs";
import {
  LEGEND_ORDER,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  PREVIOUS_LABEL,
  ShareBar,
  TrendText,
  useUsageFormat,
  WINDOW_OPTION,
} from "./format";
import { PromptCacheSection, PromptCacheTile } from "./prompt-cache";
import { type SheetContext, UsageSheetView } from "./sheets";

const DIM_LABEL: Record<BreakdownDim, TranslationKey> = {
  workflow: "usage.axis.workflow",
  person: "usage.axis.person",
  model: "usage.axis.model",
  conversation: "usage.axis.conversation",
  task: "usage.axis.task",
};

const REMAINDER_LABEL: Record<BreakdownDim, TranslationKey> = {
  workflow: "usage.remainder.workflow",
  person: "usage.remainder.person",
  model: "usage.remainder.model",
  conversation: "usage.remainder.conversation",
  task: "usage.remainder.task",
};

const FRESH_ORIGINS: readonly (keyof typeof ORIGIN_HELP)[] = [
  "chat",
  "authoring",
  "workflowRuns",
  "knowledge",
  "reviews",
];

type TableRow = { kind: "row"; row: BreakdownRow } | { kind: "rest"; rest: BreakdownRemainder };

function useLlmQuery(
  enabled: boolean,
  span: TimeSpan & { window: StatsWindow },
  axis?: ConsumptionAxis,
) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["usage-llm", axis ?? "window", span],
    enabled,
    queryFn: () => apiCall("get", "/v1/stats/llm", { query: llmStatsQuery(span, axis) }),
    ...live,
  });
}

function useRunsQuery(enabled: boolean, span: TimeSpan & { window: StatsWindow }) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["usage", "runs-by-workflow", span],
    enabled,
    queryFn: () =>
      apiCall("get", "/v1/stats/executions", {
        query: { ...windowStatsQuery(span), group_by: "workflow_id" },
      }),
    ...live,
  });
}

function sheetFromLocation(): UsageSheet | null {
  return typeof window === "undefined" ? null : usageSheetFromSearch(window.location.search);
}

export function UsageBreakdown({
  bounds,
  chooseWindow,
  budget,
  forecast,
  onBudget,
}: {
  bounds: WindowBounds;
  chooseWindow: (next: string) => void;
  budget: BudgetSummary;
  forecast: BudgetForecast | null;
  onBudget: () => void;
}) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("stats:read");
  const canAll = session.permissions.includes("stats:read:all");
  const canWriteSettings = session.permissions.includes("settings:write");
  const canWriteGlobal = canWriteSettings && session.permissions.includes("settings:write:global");
  const title = t("resource.usage.title");

  const previous = useMemo(() => ({ ...previousBounds(bounds), window: bounds.window }), [bounds]);
  const unit = windowBucket(bounds.window);

  const dims = useMemo(() => breakdownDims(session.permissions), [session.permissions]);
  const acceptDim = useCallback(
    (value: string): value is BreakdownDim => isBreakdownDim(value) && dims.includes(value),
    [dims],
  );
  const navigate = useNavigate();
  const [by, setBy] = useSearchParamState<BreakdownDim>("by", "workflow", acceptDim);
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const [sheet, setSheet] = useState<UsageSheet | null>(sheetFromLocation);
  useEffect(() => {
    void searchStr;
    setSheet(sheetFromLocation());
  }, [searchStr]);
  const openSheet = useCallback((next: UsageSheet | null) => {
    setSheet(next);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${usageSheetSearch(window.location.search, next)}${window.location.hash}`,
    );
  }, []);
  const [priceModel, setPriceModel] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);

  const flowNow = useLlmQuery(allowed, bounds, "flow");
  const flowBefore = useLlmQuery(allowed, previous, "flow");
  const workflowNow = useLlmQuery(allowed, bounds, "workflow");
  const workflowBefore = useLlmQuery(allowed, previous, "workflow");
  const runsNow = useRunsQuery(allowed, bounds);
  const runsBefore = useRunsQuery(allowed, previous);
  const wantModels = by === "model" || sheet?.kind === "model";
  const modelNow = useLlmQuery(allowed && wantModels, bounds, "model");
  const modelBefore = useLlmQuery(allowed && by === "model", previous, "model");
  const personNow = useLlmQuery(allowed && canAll, bounds, "user");
  const personBefore = useLlmQuery(allowed && canAll && by === "person", previous, "user");
  const wantConversations = canAll && (by === "conversation" || sheet?.kind === "conversation");
  const conversationNow = useLlmQuery(allowed && wantConversations, bounds, "conversation");
  const conversationBefore = useLlmQuery(
    allowed && canAll && by === "conversation",
    previous,
    "conversation",
  );
  const wantTasks = allowed && by === "task" && dims.includes("task");
  const taskNow = useLlmQuery(wantTasks, bounds, "task");
  const taskBefore = useLlmQuery(wantTasks, previous, "task");
  const promptCache = usePromptCacheFlows(bounds, allowed);
  const settings = useQuery({
    queryKey: ["usage-price-setting", session.tenant.id],
    enabled: allowed && canWriteSettings,
    retry: false,
    queryFn: () =>
      apiCall("get", "/v1/settings/{path}", {
        path: { path: PRICE_SETTING },
        query: { tenant: session.tenant.id },
      }),
  });
  const priceSetting = settings.data;
  const directory = useActorDirectory(canAll);

  const usage = useMemo(() => llmWindow(flowNow.data), [flowNow.data]);
  const before = useMemo(() => llmWindow(flowBefore.data), [flowBefore.data]);
  const currency = usage?.cost?.currency ?? "USD";
  const format = useUsageFormat(currency);
  const origins = useMemo(() => originRows(flowNow.data), [flowNow.data]);
  const chart = useMemo(
    () => originChart(flowNow.data, bounds, unit),
    [flowNow.data, bounds, unit],
  );
  const runCounts = useMemo(() => runsByWorkflow(runsNow.data), [runsNow.data]);
  const runCountsBefore = useMemo(() => runsByWorkflow(runsBefore.data), [runsBefore.data]);

  const workflowGroups = useMemo(() => llmGroups(workflowNow.data), [workflowNow.data]);
  const workflowGroupsBefore = useMemo(
    () => (workflowBefore.data ? llmGroups(workflowBefore.data) : null),
    [workflowBefore.data],
  );
  const workflowCosts = useMemo<WorkflowRunCost[]>(() => {
    const priorCost = new Map(
      (workflowGroupsBefore ?? []).map((group) => [group.key.workflow ?? "", group.cost]),
    );
    return workflowGroups
      .filter((group) => (group.key.workflow ?? "") !== "")
      .map((group) => {
        const id = group.key.workflow ?? "";
        return {
          workflowId: id,
          cost: group.cost,
          runs: runCounts.get(id) ?? 0,
          previousCost: workflowGroupsBefore ? (priorCost.get(id) ?? 0) : null,
          previousRuns: runCountsBefore.get(id) ?? 0,
        };
      });
  }, [workflowGroups, workflowGroupsBefore, runCounts, runCountsBefore]);

  const persons = useMemo(
    () => (usage && personNow.data ? breakdown(personNow.data, "user", usage).rows : null),
    [usage, personNow.data],
  );
  const settling =
    flowNow.isPending ||
    [workflowNow, workflowBefore, runsNow, runsBefore, personNow].some((query) => query.isLoading);
  const hints = useMemo(
    () =>
      usage
        ? usageHints({
            workflows: workflowCosts,
            unpricedModels: unpricedModels(flowNow.data),
            forecast,
            persons,
          })
        : [],
    [usage, workflowCosts, flowNow.data, forecast, persons],
  );

  const workflowIds = useMemo(() => {
    const ids = new Set(workflowCosts.map((row) => row.workflowId));
    if (sheet?.kind === "workflow") ids.add(sheet.id);
    return [...ids].sort();
  }, [workflowCosts, sheet]);
  const workflowLookups = useQueries({
    queries: workflowIds.map((id) => ({
      queryKey: ["usage-workflow", id],
      enabled: allowed,
      retry: false,
      queryFn: () => apiCall("get", "/v1/workflows/{id}", { path: { id } }),
    })),
  });
  const workflowLookup = useMemo(() => {
    const byId = new Map<string, WorkflowNameLookup>();
    workflowIds.forEach((id, index) => {
      const lookup = workflowLookups[index];
      const failed =
        lookup?.error instanceof ApiError ? lookup.error.status : lookup?.error ? 0 : null;
      byId.set(id, workflowNameLookup(lookup?.data, failed));
    });
    return byId;
  }, [workflowIds, workflowLookups]);
  const workflowName = useCallback(
    (id: string) => {
      const lookup = workflowLookup.get(id);
      if (lookup?.kind === "named") return lookup.name;
      if (lookup?.kind === "gone") return t("resource.usage.unknownWorkflow");
      if (lookup?.kind === "unreadable") return t("resource.usage.workflowUnreadable");
      return "…";
    },
    [workflowLookup, t],
  );
  const personName = useCallback(
    (id: string | null) =>
      id ? (directory.get(actorKey("user", id)) ?? t("usage.personUnknown")) : t("usage.noPerson"),
    [directory, t],
  );
  const modelGroups = useMemo(() => llmGroups(modelNow.data), [modelNow.data]);
  const modelName = useCallback(
    (id: string) => modelGroups.find((group) => group.key.model === id)?.modelName ?? id,
    [modelGroups],
  );
  const conversationGroups = useMemo(() => llmGroups(conversationNow.data), [conversationNow.data]);
  const taskIds = useMemo(
    () => [...new Set(llmGroups(taskNow.data).flatMap((group) => group.key.task ?? []))].sort(),
    [taskNow.data],
  );
  const taskLookups = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: taskKeys.detail(id),
      enabled: wantTasks,
      retry: false,
      queryFn: () => apiCall("get", "/v1/tasks/{id}", { path: { id } }),
    })),
  });
  const taskName = (id: string): string => {
    const lookup = taskLookups[taskIds.indexOf(id)];
    const failed =
      lookup?.error instanceof ApiError ? lookup.error.status : lookup?.error ? 0 : null;
    const named = workflowNameLookup(lookup?.data, failed);
    if (named.kind === "named") return named.name;
    return named.kind === "pending" ? "…" : t("usage.taskGone");
  };

  const costTrend = trendOf(
    usage?.cost?.amount ?? (usage && usage.calls === 0 ? 0 : null),
    before ? (before.cost?.amount ?? (before.calls === 0 ? 0 : null)) : undefined,
  );
  const callsTrend = trendOf(usage?.calls ?? null, before?.calls);
  const period = t(WINDOW_OPTION[bounds.window]);
  const previousLabel = t(PREVIOUS_LABEL[bounds.window]);

  const driver = useMemo(() => {
    if (costTrend.kind !== "more") return null;
    const beforeOrigins = originRows(flowBefore.data);
    const current = [
      ...workflowCosts.map((row) => ({ key: `w:${row.workflowId}`, cost: row.cost })),
      ...origins
        .filter((row) => row.key !== "workflowRuns")
        .map((row) => ({ key: `o:${row.key}`, cost: row.cost })),
    ];
    const prior = new Map<string, number>([
      ...workflowCosts.map((row) => [`w:${row.workflowId}`, row.previousCost ?? 0] as const),
      ...beforeOrigins.map((row) => [`o:${row.key}`, row.cost ?? 0] as const),
    ]);
    return mainDriver(current, prior);
  }, [costTrend.kind, flowBefore.data, workflowCosts, origins]);

  const ctx: SheetContext = {
    bounds,
    window: usage,
    format,
    canAll,
    canWriteSettings,
    priceSettingReadable: priceSetting !== undefined,
    origins,
    workflowCost: (id) => workflowCosts.find((row) => row.workflowId === id) ?? null,
    modelGroup: (id) => modelGroups.find((group) => group.key.model === id) ?? null,
    conversationGroup: (id) =>
      conversationGroups.find((group) => group.key.conversation === id) ?? null,
    modelsPending: modelNow.isPending,
    conversationsPending: conversationNow.isPending,
    workflowName,
    personName,
    modelName,
    open: openSheet,
    close: () => openSheet(null),
    setPrice: (model) => setPriceModel(model),
  };

  const fresh =
    usage !== null &&
    usage.calls === 0 &&
    before !== null &&
    before.calls === 0 &&
    (budget.usedTokens ?? 0) === 0;

  if (fresh)
    return (
      <div className="flex flex-col gap-6" data-testid="usage-fresh">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4">
          <IconTile>
            <Gauge />
          </IconTile>
          <p className="min-w-0 flex-1 text-sm">{t("usage.fresh.line")}</p>
          {renderAction({
            label: t("usage.fresh.action"),
            href: absolute(chatNewHref()),
            variant: "primary",
            testId: "usage-fresh-chat",
          })}
        </div>
        <Section label={t("usage.fresh.where")}>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {FRESH_ORIGINS.map((origin) => (
              <li key={origin} className="flex items-start gap-3 rounded-lg border p-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(ORIGIN_LABEL[origin])}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(ORIGIN_HELP[origin])}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    );

  const empty = usage !== null && usage.calls === 0;

  const sentence = (() => {
    if (!usage) return "";
    if (empty) return t("usage.summary.empty");
    if (costTrend.kind === "more" || costTrend.kind === "less") {
      const lead = t(costTrend.kind === "more" ? "usage.summary.more" : "usage.summary.less", {
        percent: costTrend.percent,
        previous: previousLabel,
      });
      const name = driver
        ? driver.key.startsWith("w:")
          ? workflowName(driver.key.slice(2))
          : t(ORIGIN_LABEL[driver.key.slice(2) as keyof typeof ORIGIN_LABEL])
        : null;
      return `${lead}${
        name && driver
          ? t("usage.summary.driver", { name, amount: format.money(driver.delta) })
          : ""
      }.`;
    }
    if (costTrend.kind === "same")
      return `${t("usage.summary.same", { previous: previousLabel })}.`;
    if (!usage.cost)
      return t("usage.summary.coreUnpriced", { period, count: format.count(usage.calls) });
    return t(usage.calls === 1 ? "usage.summary.core.one" : "usage.summary.core.other", {
      period,
      amount: format.money(usage.cost.amount),
      count: format.count(usage.calls),
    });
  })();

  const summary = (
    <SummaryLine
      testId="usage-sentence"
      loading={flowNow.isPending}
      text={
        <span data-testid="usage-spend">
          {sentence}
          {empty && bounds.window !== "thisMonth" ? (
            <>
              {" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => chooseWindow("thisMonth")}
                data-testid="usage-show-month"
              >
                {t("usage.summary.showMonth")}
              </button>
            </>
          ) : null}
        </span>
      }
      help={`${t("usage.purpose")} ${t("usage.trend.help")}`}
      helpLabel={title}
      aside={
        <SegmentedControl
          label={t("resource.usage.windowPicker")}
          value={bounds.window}
          onValueChange={chooseWindow}
          testId="usage-window"
          options={STATS_WINDOWS.map((candidate) => ({
            value: candidate,
            label: t(WINDOW_OPTION[candidate]),
            testId: `usage-window-${candidate}`,
          }))}
        />
      }
    />
  );

  const tiles = flowNow.isPending ? (
    <div className="@container">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <TileSkeleton key={index} />
        ))}
      </div>
    </div>
  ) : (
    <div className="@container">
      <section
        aria-label={t("usage.kpi.label")}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-testid="usage-kpis"
      >
        <KpiTile
          label={`${t("resource.usage.cost")} · ${period}`}
          testId="usage-kpi-cost"
          prefix={
            usage?.cost && usage.cost.unpricedCalls > 0 ? t("overview.operations.atLeast") : null
          }
          value={
            usage?.cost
              ? format.money(usage.cost.amount)
              : usage && usage.calls > 0
                ? undefined
                : format.money(0)
          }
          note={usage && usage.calls > 0 && !usage.cost ? t("usage.kpi.costUnknown") : undefined}
          detail={
            usage?.cost && usage.cost.unpricedCalls > 0 ? (
              t("overview.operations.unpricedCalls", {
                calls: format.count(usage.cost.unpricedCalls),
              })
            ) : (
              <TrendText trend={costTrend} window={bounds.window} testId="usage-cost-trend" />
            )
          }
        />
        <KpiTile
          label={`${t("usage.calls")} · ${period}`}
          testId="usage-kpi-calls"
          value={format.count(usage?.calls ?? 0)}
          detail={
            usage && usage.failedCalls > 0 ? (
              <button
                type="button"
                className="relative underline underline-offset-2 hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3.5 pointer-coarse:after:-inset-x-1"
                onClick={() => openSheet({ kind: "failed" })}
                data-testid="usage-failed-open"
              >
                {t("overview.operations.failedCount", { count: format.count(usage.failedCalls) })}
              </button>
            ) : (
              <TrendText trend={callsTrend} window={bounds.window} />
            )
          }
        />
        <KpiTile
          label={`${t("usage.kpi.saved")} · ${period}`}
          testId="usage-kpi-cache"
          value={format.money(usage?.cacheSavings ?? 0)}
        />
        <PromptCacheTile
          read={promptCache.read}
          pending={promptCache.pending}
          period={period}
          onRetry={promptCache.retry}
        />
      </section>
    </div>
  );

  const hintText = (hint: UsageHint): string => {
    if (hint.kind === "runCost")
      return t("usage.hint.runCost", {
        name: workflowName(hint.workflowId),
        factor: hint.factor.toLocaleString(),
        previous: previousLabel,
      });
    if (hint.kind === "unpricedModel")
      return t("usage.hint.unpricedModel", { name: modelName(hint.model) });
    if (hint.kind === "unpricedModels")
      return t("usage.hint.unpricedModels", { count: hint.count });
    if (hint.kind === "budget") return t("usage.hint.budget", { day: hint.day });
    return t("usage.hint.person", { name: personName(hint.userId), percent: hint.percent });
  };
  const hintIcon = (hint: UsageHint): ReactNode =>
    hint.kind === "runCost" ? (
      <TrendingUp />
    ) : hint.kind === "budget" ? (
      <Gauge />
    ) : hint.kind === "personShare" ? (
      <Users />
    ) : (
      <CircleExclamationPoint />
    );
  const hintAction = (hint: UsageHint): ReactNode => {
    const action = (label: string, onClick: () => void) => (
      <ActionButton size="sm" onClick={onClick} testId={`usage-hint-${hint.kind}-action`}>
        {label}
      </ActionButton>
    );
    if (hint.kind === "runCost")
      return action(t("usage.hint.viewCost"), () =>
        openSheet({ kind: "workflow", id: hint.workflowId }),
      );
    if (hint.kind === "unpricedModel")
      return action(t("usage.hint.viewModel"), () => openSheet({ kind: "model", id: hint.model }));
    if (hint.kind === "unpricedModels")
      return action(t("usage.hint.viewModels"), () => {
        setBy("model");
        document.getElementById("usage-breakdown")?.scrollIntoView({ block: "start" });
      });
    if (hint.kind === "budget")
      return canWriteSettings ? (
        action(t("usage.hint.adjustBudget"), onBudget)
      ) : (
        <span className="text-xs text-muted-foreground">{t("usage.askAdmin")}</span>
      );
    return action(t("usage.hint.viewBreakdown"), () => {
      setBy("person");
      document.getElementById("usage-breakdown")?.scrollIntoView({ block: "start" });
    });
  };

  const hintSection = (
    <section className="flex flex-col gap-3" data-testid="usage-hints">
      <div className="flex items-center gap-1">
        <SectionHeading>{t("usage.hint.title")}</SectionHeading>
        <ContextHelp label={t("usage.hint.title")} testId="usage-hints-help">
          {t("usage.hint.help")}
        </ContextHelp>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{hints.length}</span>
      </div>
      {hints.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {hints.map((hint) => (
            <li
              key={`${hint.kind}-${"workflowId" in hint ? hint.workflowId : ""}`}
              className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[auto_1fr_auto]"
              data-testid="usage-hint"
              data-hint={hint.kind}
            >
              <IconTile className="text-warning">{hintIcon(hint)}</IconTile>
              <span className="min-w-0">{hintText(hint)}</span>
              <span className="col-start-2 sm:col-start-auto">{hintAction(hint)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="usage-hints-none">
          {t("usage.hint.none")}
        </p>
      )}
    </section>
  );

  const value = (amount: number) =>
    chart.measure === "cost" ? format.money(amount) : format.count(amount);
  const chartSection = (
    <Section
      label={`${t("usage.chart.title")} · ${t(unit === "hour" ? "usage.chart.perHour" : "usage.chart.perDay")}`}
      aside={
        <ActionButton
          variant="ghost"
          size="sm"
          onClick={() => setAsTable((current) => !current)}
          testId="usage-chart-toggle"
        >
          {t(asTable ? "usage.chart.asChart" : "usage.chart.asTable")}
        </ActionButton>
      }
      testId="usage-chart-section"
    >
      <div className="rounded-lg border p-4">
        {flowNow.isError ? (
          <p className="text-sm text-muted-foreground">{t("usage.chart.unreadable")}</p>
        ) : asTable ? (
          <OriginChartTable chart={chart} unit={unit} format={format} value={value} />
        ) : (
          <OriginChartSvg chart={chart} unit={unit} format={format} value={value} />
        )}
        {chart.measure === "tokens" ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("usage.chart.tokensOnly")}</p>
        ) : null}
        <OriginLegend
          rows={origins}
          measure={chart.measure}
          format={format}
          onOpen={(origin) => openSheet({ kind: "origin", id: origin })}
        />
      </div>
    </Section>
  );

  const dimQueries = {
    workflow: { now: workflowNow, before: workflowBefore },
    person: { now: personNow, before: personBefore },
    model: { now: modelNow, before: modelBefore },
    conversation: { now: conversationNow, before: conversationBefore },
    task: { now: taskNow, before: taskBefore },
  } as const;
  const active = dimQueries[by];
  const table: TableRow[] = (() => {
    if (!usage || !active.now.data) return [];
    const result = breakdown(
      active.now.data,
      BREAKDOWN_AXIS[by],
      usage,
      active.before.data ?? undefined,
    );
    return [
      ...result.rows.map((row) => ({ kind: "row" as const, row })),
      ...(result.remainder ? [{ kind: "rest" as const, rest: result.remainder }] : []),
    ];
  })();
  const rowName = (row: BreakdownRow): string => {
    if (by === "workflow") return workflowName(row.key);
    if (by === "person") return personName(row.key);
    if (by === "model") return row.group.modelName ?? row.key;
    if (by === "task") return taskName(row.key);
    return (
      row.group.conversation?.title ??
      t("usage.untitledConversation", {
        date: format.dateLabel(row.group.conversation?.updatedAt ?? ""),
      })
    );
  };
  const extraLabel: Partial<Record<BreakdownDim, TranslationKey>> = {
    workflow: "resource.usage.runs",
    model: "usage.sheet.errorRate",
    conversation: "usage.lastActive",
  };
  const extra = (row: BreakdownRow): string => {
    if (by === "workflow") return format.count(runCounts.get(row.key) ?? 0);
    if (by === "model") return format.percent(row.calls > 0 ? row.failedCalls / row.calls : null);
    if (by === "task") return "";
    return format.dateLabel(row.group.conversation?.updatedAt ?? "");
  };
  const columns: CockpitColumn<TableRow>[] = (() => {
    const column = tableColumns<TableRow>({ t, dateTime });
    const list: CockpitColumn<TableRow>[] = [
      column.custom(
        "name",
        (item) => (item.kind === "row" ? rowName(item.row) : ""),
        t(DIM_LABEL[by]),
        (item) =>
          item.kind === "rest" ? (
            <span className="text-muted-foreground" data-testid="usage-remainder">
              {t(REMAINDER_LABEL[by])}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-2.5">
              {by === "conversation" ? (
                <IconTile size="sm">
                  <MessageSquare />
                </IconTile>
              ) : null}
              <span className="min-w-0">
                <span className="block truncate font-medium" data-testid="usage-row-name">
                  {rowName(item.row)}
                </span>
                {by === "conversation" && item.row.group.conversation ? (
                  <span className="block text-xs text-muted-foreground">
                    {personName(item.row.group.conversation.ownerId)}
                  </span>
                ) : null}
                {by === "model" && item.row.cost === null ? (
                  <span className="block text-xs text-muted-foreground">{t("usage.unpriced")}</span>
                ) : null}
              </span>
            </span>
          ),
        { width: "w-[40%]" },
      ),
      column.custom(
        "cost",
        (item) => (item.kind === "row" ? (item.row.cost ?? -1) : -1),
        t("resource.usage.cost"),
        (item) => {
          const cost = item.kind === "row" ? item.row.cost : item.rest.cost;
          const tokens = item.kind === "row" ? item.row.tokens : null;
          return (
            <span
              className={
                item.kind === "rest"
                  ? "whitespace-nowrap text-muted-foreground tabular-nums"
                  : "whitespace-nowrap tabular-nums"
              }
            >
              {cost !== null
                ? format.money(cost)
                : tokens !== null && usage && !usage.cost
                  ? `${format.count(tokens)} ${t("resource.field.tokens")}`
                  : t("usage.unpriced")}
            </span>
          );
        },
        { align: "end", cardLabel: true },
      ),
      column.custom(
        "calls",
        (item) => (item.kind === "row" ? item.row.calls : item.rest.calls),
        t("usage.calls"),
        (item) => (
          <span className="whitespace-nowrap tabular-nums">
            {format.count(item.kind === "row" ? item.row.calls : item.rest.calls)}
          </span>
        ),
        { align: "end", priority: "low", cardLabel: true },
      ),
    ];
    const extraKey = extraLabel[by];
    if (extraKey)
      list.push(
        column.custom(
          "extra",
          () => 0,
          t(extraKey),
          (item) =>
            item.kind === "row" ? (
              <span className="whitespace-nowrap tabular-nums">{extra(item.row)}</span>
            ) : null,
          { align: "end", priority: "low", cardLabel: true },
        ),
      );
    list.push(
      column.custom(
        "share",
        (item) => (item.kind === "row" ? item.row.share : item.rest.share),
        t("resource.field.share"),
        (item) => {
          const share = item.kind === "row" ? item.row.share : item.rest.share;
          return (
            <span className="flex items-center gap-2" title={t("usage.shareHelp")}>
              <ShareBar share={share} color={item.kind === "rest" ? "var(--border)" : undefined} />
              <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {format.percent(share)}
              </span>
            </span>
          );
        },
        { width: "w-40", priority: "low" },
      ),
      column.custom(
        "trend",
        () => 0,
        t("usage.trend.column"),
        (item) =>
          item.kind === "row" ? <TrendText trend={item.row.trend} window={bounds.window} /> : null,
        { align: "end" },
      ),
    );
    return list;
  })();

  const breakdownSection = (
    <div id="usage-breakdown" className="scroll-mt-4">
      <Section label={t("usage.breakdown.title")} testId="usage-breakdown">
        <DataTable
          collectionId={`usage-breakdown-${by}`}
          collectionTier="embedded"
          groupingTabs={
            <GroupingChoice
              label={t("usage.breakdown.title")}
              value={by}
              onChange={(next) => {
                if (acceptDim(next)) setBy(next);
              }}
              options={dims.map((dim) => ({ value: dim, label: t(DIM_LABEL[dim]) }))}
              testId="usage-grouping"
            />
          }
          columns={columns}
          data={table}
          getRowId={(item) => (item.kind === "row" ? item.row.key : "rest")}
          canOpen={(item) => item.kind === "row"}
          onOpen={(item) => {
            if (item.kind !== "row") return;
            if (by === "task") void navigate(routerTarget(absolute(taskHref(item.row.key))));
            else openSheet({ kind: by, id: item.row.key });
          }}
          rowLabel={(item) =>
            item.kind === "row" ? t("usage.openDetails", { name: rowName(item.row) }) : ""
          }
          pending={active.now.isPending}
          error={
            active.now.error
              ? active.now.error instanceof ApiError && active.now.error.status === 403
                ? {
                    title: t("overview.operations.notPermitted"),
                    description: t("usage.askAdmin"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void active.now.refetch(),
                  }
                : {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void active.now.refetch(),
                  }
              : null
          }
          emptyState={{
            zero: { title: t("usage.breakdown.empty", { segment: t(DIM_LABEL[by]) }) },
            filtered: {
              title: t("usage.breakdown.empty", { segment: t(DIM_LABEL[by]) }),
              description: t("resource.broaderSearch"),
              resetLabel: t("usage.summary.showMonth"),
              onReset: () => chooseWindow("thisMonth"),
            },
          }}
          hasActiveFilters={false}
          sorting={[] as SortingState}
          onSortingChange={() => {}}
          columnsLabel={`${t("catalog.columns")} · ${t(DIM_LABEL[by])}`}
          recordsLabel={t("catalog.records")}
          actionsLabel={t("common.actions")}
        />
      </Section>
    </div>
  );

  const flowsByOrigin = LEGEND_ORDER.flatMap((origin) => {
    const row = origins.find((candidate) => candidate.key === origin);
    return row ? [`${t(ORIGIN_LABEL[origin])}: ${row.flows.join(", ")}`] : [];
  });
  const tokens = usage?.tokens;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const techSection = (
    <CollapsibleSection label={t("usage.tech.title")} testId="usage-tech">
      <div className="flex flex-col gap-4">
        <FactList
          items={[
            { label: t("usage.tech.input"), value: format.count(tokens?.prompt ?? 0) },
            { label: t("usage.tech.output"), value: format.count(tokens?.completion ?? 0) },
            { label: t("usage.tech.cacheRead"), value: format.count(tokens?.cacheRead ?? 0) },
            {
              label: t("usage.tech.cacheWritten"),
              value: format.count(tokens?.cacheCreation ?? 0),
            },
            { label: t("usage.tech.total"), value: format.count(tokens?.total ?? 0) },
            {
              label: t("usage.tech.unpriced"),
              value: `${unpricedModels(flowNow.data).join(", ") || "–"} · ${t(
                "overview.operations.unpricedCalls",
                { calls: format.count(usage?.cost?.unpricedCalls ?? 0) },
              )}`,
            },
            {
              label: t("usage.kpi.budget"),
              value:
                budget.budgetTokens !== null && budget.usedTokens !== null
                  ? t("usage.tech.budget", {
                      used: format.count(budget.usedTokens),
                      budget: format.count(budget.budgetTokens),
                      remaining: format.count(budget.remainingTokens ?? 0),
                    })
                  : t("resource.usage.noCap"),
            },
            { label: t("usage.tech.priceSource"), value: t("usage.tech.priceSourceValue") },
            { label: t("usage.tech.timeZone"), value: timeZone },
            {
              label: t("usage.tech.flows"),
              value: <span className="font-mono text-xs">{flowsByOrigin.join(" · ")}</span>,
            },
          ]}
        />
        <p className="text-sm text-muted-foreground">{t("usage.tech.access")}</p>
        <CodeBlock
          label={t("usage.tech.query")}
          code={`sk stats llm --bucket ${unit} --from ${bounds.from} --to ${bounds.to} --tz ${timeZone} --group-by ${BREAKDOWN_AXIS[by]}\n\nGET ${llmStatsEndpoint(bounds, BREAKDOWN_AXIS[by])}`}
        />
      </div>
    </CollapsibleSection>
  );

  return (
    <div data-testid="usage-breakdown-tab">
      <div className="flex min-w-0 flex-col gap-8">
        <div className="flex flex-col gap-3">
          {summary}
          {tiles}
        </div>
        {empty ? null : settling ? (
          <div
            className="flex flex-col gap-8"
            role="status"
            aria-busy="true"
            aria-label={t("common.loading")}
            data-testid="usage-body-loading"
          >
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-28 w-full" />
            </div>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-80 w-full" />
            </div>
          </div>
        ) : (
          <>
            {hintSection}
            {chartSection}
            {breakdownSection}
            <PromptCacheSection
              read={promptCache.read}
              pending={promptCache.pending}
              onRetry={promptCache.retry}
            />
          </>
        )}
        {techSection}
      </div>
      <UsageSheetView ctx={ctx} sheet={sheet} />
      {priceModel ? (
        <PriceDialog
          open
          onOpenChange={(open) => (open ? undefined : setPriceModel(null))}
          model={priceModel}
          modelName={modelName(priceModel)}
          currentPrices={Array.isArray(priceSetting?.value) ? priceSetting.value : []}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
          pricedBounds={bounds}
        />
      ) : null}
    </div>
  );
}
