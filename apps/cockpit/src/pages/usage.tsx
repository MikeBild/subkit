import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { CircleAlert, Download, Gauge, MessageSquare, TrendingUp, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { actorKey } from "@/app/actor-directory-model";
import { absolute, chatNewHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import {
  ActionButton,
  ActionMenu,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  ContextHelp,
  DataTable,
  FactList,
  GroupingTabs,
  IconTile,
  KpiTile,
  Page,
  PageHeader,
  renderAction,
  Section,
  SectionHeading,
  SegmentedControl,
  SummaryLine,
  TileSkeleton,
} from "@/components/cockpit/patterns";
import { tableColumns } from "@/components/cockpit/table-columns";
import { ForbiddenState } from "@/components/failure-state";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { usePromptCacheFlows } from "@/pages/operations-bar";
import {
  isStatsWindow,
  llmStatsEndpoint,
  llmStatsQuery,
  previousBounds,
  rollingDays,
  STATS_WINDOWS,
  type StatsWindow,
  type TimeSpan,
  usageWindowFromUrl,
  usageWindowSearch,
  type WindowBounds,
  windowBounds,
  windowBucket,
  windowStatsQuery,
} from "@/pages/operations-figures";
import { PromptCacheSection, PromptCacheTile } from "@/pages/prompt-cache";
import { OriginChartSvg, OriginChartTable, OriginLegend } from "@/pages/usage-chart";
import {
  BudgetDialog,
  CurrencyDialog,
  ExportDialog,
  ForecastText,
  PRICE_SETTING,
  PriceDialog,
} from "@/pages/usage-dialogs";
import {
  LEGEND_ORDER,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  PREVIOUS_LABEL,
  ShareBar,
  TrendText,
  useUsageFormat,
  WINDOW_OPTION,
} from "@/pages/usage-format";
import {
  BREAKDOWN_AXIS,
  type BreakdownDim,
  type BreakdownRemainder,
  type BreakdownRow,
  breakdown,
  budgetForecast,
  budgetPercent,
  budgetPressure,
  budgetSummary,
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
} from "@/pages/usage-model";
import { type SheetContext, UsageSheetView } from "@/pages/usage-sheets";

const PRESSURE_TONE = {
  ample: null,
  tightening: "text-warning",
  critical: "text-destructive",
} as const;

const DIM_LABEL: Record<BreakdownDim, TranslationKey> = {
  workflow: "usage.axis.workflow",
  person: "usage.axis.person",
  model: "usage.axis.model",
  conversation: "usage.axis.conversation",
};

const REMAINDER_LABEL: Record<BreakdownDim, TranslationKey> = {
  workflow: "usage.remainder.workflow",
  person: "usage.remainder.person",
  model: "usage.remainder.model",
  conversation: "usage.remainder.conversation",
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

export function UsagePage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const live = useLiveQueryOptions();
  const allowed = session.permissions.includes("stats:read");
  const canAll = session.permissions.includes("stats:read:all");
  const canWriteSettings = session.permissions.includes("settings:write");
  const canWriteGlobal = canWriteSettings && session.permissions.includes("settings:write:global");
  const title = t("resource.usage.title");

  const [bounds, setBounds] = useState<WindowBounds>(() =>
    windowBounds(usageWindowFromUrl(window.location.search)),
  );
  const previous = useMemo(() => ({ ...previousBounds(bounds), window: bounds.window }), [bounds]);
  const seven = useMemo(() => ({ ...rollingDays(7), window: "thisWeek" as const }), []);
  const unit = windowBucket(bounds.window);
  const chooseWindow = (next: string) => {
    if (!isStatsWindow(next)) return;
    setBounds(windowBounds(next));
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${usageWindowSearch(window.location.search, next)}${window.location.hash}`,
    );
  };

  const acceptDim = useCallback(
    (value: string): value is BreakdownDim =>
      isBreakdownDim(value) && (canAll || (value !== "person" && value !== "conversation")),
    [canAll],
  );
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
  const [dialog, setDialog] = useState<
    | { kind: "budget" }
    | { kind: "currency" }
    | { kind: "export" }
    | { kind: "price"; model: string }
    | null
  >(null);
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
  const lastSeven = useLlmQuery(allowed, seven);
  const promptCache = usePromptCacheFlows(bounds, allowed);
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiCall("get", "/v1/status", {}),
    ...live,
  });
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
  const budget = useMemo(() => budgetSummary(status.data), [status.data]);
  const forecast = useMemo(
    () =>
      status.data
        ? budgetForecast({
            usedTokens: budget.usedTokens,
            budgetTokens: budget.budgetTokens,
            lastSevenDaysTokens: llmWindow(lastSeven.data)?.tokens.total ?? null,
            now: new Date(),
          })
        : null,
    [status.data, budget, lastSeven.data],
  );

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
    setPrice: (model) => setDialog({ kind: "price", model }),
  };

  const header = (
    <PageHeader
      title={title}
      secondary={
        allowed ? (
          <ActionButton onClick={() => setDialog({ kind: "export" })} testId="usage-export">
            <Download aria-hidden="true" />
            {t("usage.export.open")}
          </ActionButton>
        ) : undefined
      }
      menu={
        allowed && canWriteSettings ? (
          <ActionMenu
            alwaysMenu
            testId="usage-settings-menu"
            items={[
              {
                label: t("usage.hint.adjustBudget"),
                onSelect: () => setDialog({ kind: "budget" }),
                testId: "usage-menu-budget",
              },
              {
                label: t("usage.currency.action"),
                onSelect: () => setDialog({ kind: "currency" }),
                testId: "usage-menu-currency",
              },
            ]}
          />
        ) : undefined
      }
    />
  );

  if (!allowed)
    return (
      <Page kind="list" surface="collection" testId="resource-usage" scroll="page" header={header}>
        <ForbiddenState />
      </Page>
    );

  const fresh =
    usage !== null &&
    usage.calls === 0 &&
    before !== null &&
    before.calls === 0 &&
    (budget.usedTokens ?? 0) === 0;

  if (fresh)
    return (
      <Page
        kind="list"
        surface="collection"
        testId="resource-usage"
        scroll="page"
        header={<PageHeader title={title} />}
      >
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
          {budget.budgetTokens === null && status.data ? (
            <p className="text-sm text-muted-foreground">{t("usage.budget.none")}</p>
          ) : null}
        </div>
      </Page>
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

  const percent = budgetPercent(budget);
  const pressure = budgetPressure(budget);
  const budgetHinted = hints.some((hint) => hint.kind === "budget");
  const budgetTile = status.isError ? (
    <KpiTile
      label={`${t("usage.kpi.budget")} · ${t("overview.operations.month")}`}
      testId="usage-kpi-budget"
      note={t("resource.usage.budgetUnreadable")}
    />
  ) : budget.budgetTokens === null ? (
    <KpiTile
      label={`${t("usage.kpi.budget")} · ${t("overview.operations.month")}`}
      testId="usage-kpi-budget"
      note={
        <>
          <span data-testid="usage-budget-uncapped">{t("resource.usage.noCap")}</span>
          {canWriteSettings ? (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => setDialog({ kind: "budget" })}
              data-testid="usage-budget-set"
            >
              {t("resource.usage.setCap")}
            </button>
          ) : null}
        </>
      }
    />
  ) : (
    <KpiTile
      label={`${t("usage.kpi.budget")} · ${t("overview.operations.month")}`}
      testId="usage-kpi-budget"
      data={{ "data-budget-pressure": pressure ?? undefined }}
      value={t("usage.kpi.budgetPercent", { percent: percent ?? 0 })}
      tone={pressure ? PRESSURE_TONE[pressure] : null}
      detail={
        !forecast || forecast.kind === "uncapped" ? null : budgetHinted ? (
          <span title={t("usage.forecast.help")}>
            <ForecastText forecast={forecast} />
          </span>
        ) : (
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            title={t("usage.forecast.help")}
            onClick={() => setDialog({ kind: "budget" })}
            data-testid="usage-budget-open"
          >
            <ForecastText forecast={forecast} />
          </button>
        )
      }
    />
  );

  const tiles = flowNow.isPending ? (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((index) => (
        <TileSkeleton key={index} />
      ))}
    </div>
  ) : (
    <section
      aria-label={t("usage.kpi.label")}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
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
      {budgetTile}
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
      <CircleAlert />
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
        action(t("usage.hint.adjustBudget"), () => setDialog({ kind: "budget" }))
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

  const dims = (["workflow", "person", "model", "conversation"] as const).filter(
    (dim) => canAll || (dim !== "person" && dim !== "conversation"),
  );
  const breakdownSection = (
    <div id="usage-breakdown" className="scroll-mt-4">
      <Section label={t("usage.breakdown.title")} testId="usage-breakdown">
        <DataTable
          collectionId={`usage-breakdown-${by}`}
          collectionTier="embedded"
          groupingTabs={
            <GroupingTabs
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
            const kind = by === "person" ? "person" : by;
            openSheet({ kind, id: item.row.key });
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

  const modelForPrice = dialog?.kind === "price" ? dialog.model : null;
  return (
    <Page kind="list" surface="collection" testId="resource-usage" scroll="page" header={header}>
      <div className="flex min-w-0 flex-col gap-8">
        <div className="flex flex-col gap-3">
          {summary}
          {tiles}
        </div>
        {empty ? null : (
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
      {dialog?.kind === "budget" ? (
        <BudgetDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          budget={budget}
          forecast={forecast}
          canWrite={canWriteSettings}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
        />
      ) : null}
      {dialog?.kind === "currency" ? (
        <CurrencyDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
        />
      ) : null}
      {modelForPrice ? (
        <PriceDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          model={modelForPrice}
          modelName={modelName(modelForPrice)}
          currentPrices={Array.isArray(priceSetting?.value) ? priceSetting.value : []}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
          pricedBounds={bounds}
        />
      ) : null}
      {dialog?.kind === "export" ? (
        <ExportDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          bounds={bounds}
        />
      ) : null}
    </Page>
  );
}
