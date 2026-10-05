import { useQueries, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, settingsHref, workflowHref } from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import {
  type CockpitColumn,
  DataState,
  DataTable,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { pluralKey, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  BUDGET_SETTING,
  executionStatsEndpoint,
  llmStatsEndpoint,
  STATS_WINDOWS,
  STATUS_ENDPOINT,
  type StatsWindow,
  usageWindowFromUrl,
  type WindowBounds,
  windowBounds,
} from "@/pages/operations-figures";
import {
  attributableWorkflowRows,
  budgetPercent,
  budgetPressure,
  budgetSummary,
  type ConsumptionRow,
  consumptionRows,
  type OriginRow,
  originRows,
  runsByWorkflow,
  type UsageOrigin,
  type WorkflowNameLookup,
  windowCost,
  workflowNameLookup,
} from "@/pages/usage-model";

const WINDOW_OPTION: Record<StatsWindow, TranslationKey> = {
  "24h": "resource.usage.windowOption.24h",
  "7d": "resource.usage.windowOption.7d",
  "30d": "resource.usage.windowOption.30d",
};

const PRESSURE_LABEL = {
  ample: "resource.usage.pressure.ample",
  tightening: "resource.usage.pressure.tightening",
  critical: "resource.usage.pressure.critical",
} as const satisfies Record<string, TranslationKey>;

const ORIGIN_LABEL: Record<UsageOrigin, TranslationKey> = {
  chat: "resource.usage.origin.chat",
  authoring: "resource.usage.origin.authoring",
  summaries: "resource.usage.origin.summaries",
  reviews: "resource.usage.origin.reviews",
  knowledge: "resource.usage.origin.knowledge",
  workflowRuns: "resource.usage.origin.workflowRuns",
  other: "resource.usage.origin.other",
};

function isWindow(value: string): value is StatsWindow {
  return (STATS_WINDOWS as readonly string[]).includes(value);
}

export function UsagePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const live = useLiveQueryOptions();
  const allowed = session.permissions.includes("stats:read");
  const title = t("resource.usage.title");
  const [bounds, setBounds] = useState<WindowBounds>(() =>
    windowBounds(usageWindowFromUrl(window.location.search)),
  );
  const span = bounds.window;
  const chooseWindow = (next: string) => {
    if (!isWindow(next)) return;
    setBounds(windowBounds(next));
    const params = new URLSearchParams(window.location.search);
    if (next === "30d") params.delete("window");
    else params.set("window", next);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  };

  const byFlow = useQuery({
    queryKey: ["usage-llm", "flow", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds, "flow")),
    ...live,
  });
  const byWorkflow = useQuery({
    queryKey: ["usage-llm", "workflow", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds, "workflow")),
    ...live,
  });
  const byModel = useQuery({
    queryKey: ["usage-llm", "model", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds, "model")),
    ...live,
  });
  const runs = useQuery({
    queryKey: ["usage", "runs-by-workflow", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(`${executionStatsEndpoint(bounds)}&group_by=workflow_id`),
    ...live,
  });
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(STATUS_ENDPOINT),
    ...live,
  });

  const origins = useMemo(() => originRows(byFlow.data), [byFlow.data]);
  const workflowRows = useMemo(
    () => consumptionRows(byWorkflow.data, "workflow"),
    [byWorkflow.data],
  );
  const attributedRows = useMemo(() => attributableWorkflowRows(workflowRows), [workflowRows]);
  const modelRows = useMemo(() => consumptionRows(byModel.data, "model"), [byModel.data]);
  const runCounts = useMemo(() => runsByWorkflow(runs.data), [runs.data]);
  const budget = useMemo(() => budgetSummary(status.data), [status.data]);
  const money = useMemo(() => windowCost(byWorkflow.data), [byWorkflow.data]);
  const windowTokens = useMemo(
    () => workflowRows.reduce((sum, row) => sum + row.tokens, 0),
    [workflowRows],
  );

  const workflowIds = useMemo(
    () => workflowRows.filter((row) => !row.unattributed).map((row) => row.key),
    [workflowRows],
  );
  const workflowLookups = useQueries({
    queries: workflowIds.map((id) => ({
      queryKey: ["usage-workflow", id],
      enabled: allowed,
      retry: false,
      queryFn: () =>
        apiRequest<{ name?: string | null; slug?: string | null }>(
          `/v1/workflows/${encodeURIComponent(id)}`,
        ),
    })),
  });
  const workflowName = useMemo(() => {
    const byId = new Map<string, WorkflowNameLookup>();
    workflowIds.forEach((id, index) => {
      const lookup = workflowLookups[index];
      const failed =
        lookup?.error instanceof ApiError ? lookup.error.status : lookup?.error ? 0 : null;
      byId.set(id, workflowNameLookup(lookup?.data, failed));
    });
    return byId;
  }, [workflowIds, workflowLookups]);

  const numberFormat = locale === "de" ? "de-DE" : "en-US";
  const currency = useMemo(() => {
    const code = money?.currency ?? "EUR";
    return new Intl.NumberFormat(numberFormat, { style: "currency", currency: code });
  }, [money?.currency, numberFormat]);
  const number = useMemo(() => new Intl.NumberFormat(numberFormat), [numberFormat]);
  const percent = useMemo(
    () => new Intl.NumberFormat(numberFormat, { style: "percent", maximumFractionDigits: 0 }),
    [numberFormat],
  );

  const costCell = useCallback(
    (row: { cost: number | null; tokens: number; share: number | null }) => (
      <span className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${Math.round((row.share ?? 0) * 100)}%` }}
          />
        </span>
        <span className="whitespace-nowrap tabular-nums">
          {row.cost !== null
            ? currency.format(row.cost)
            : t(pluralKey("resource.usage.tokensAmount", row.tokens), {
                count: number.format(row.tokens),
              })}
        </span>
      </span>
    ),
    [t, currency, number],
  );

  const originColumns = useMemo<CockpitColumn<OriginRow>[]>(() => {
    const column = tableColumns<OriginRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => t(ORIGIN_LABEL[row.key]),
        t("resource.usage.axis.origin"),
        (row) => (
          <span
            className="block break-words font-medium"
            title={row.flows.filter(Boolean).join(", ") || undefined}
            data-testid="usage-origin"
            data-origin={row.key}
          >
            {t(ORIGIN_LABEL[row.key])}
            {row.key === "other" && row.flows.some(Boolean) ? (
              <span className="ml-2 font-normal text-muted-foreground">
                {row.flows.filter(Boolean).join(", ")}
              </span>
            ) : null}
          </span>
        ),
        { width: "w-[60%]" },
      ),
      column.custom("cost", (row) => row.cost ?? row.tokens, t("resource.usage.cost"), costCell, {
        width: "w-[40%]",
      }),
    ];
  }, [t, dateTime, costCell]);

  const workflowColumns = useMemo<CockpitColumn<ConsumptionRow>[]>(() => {
    const column = tableColumns<ConsumptionRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => row.key,
        t("resource.usage.axis.workflow"),
        (row) => {
          const lookup = workflowName.get(row.key);
          if (lookup?.kind === "named")
            return (
              <a
                className="block break-words font-medium underline-offset-4 hover:underline"
                href={absolute(workflowHref(row.key))}
                data-testid="usage-workflow-link"
              >
                {lookup.name}
              </a>
            );
          if (!lookup || lookup.kind === "pending") return MISSING;
          return (
            <span className="block break-words text-muted-foreground">
              {t(
                lookup.kind === "gone"
                  ? "resource.usage.unknownWorkflow"
                  : "resource.usage.workflowUnreadable",
              )}
            </span>
          );
        },
        { width: "w-[52%]" },
      ),
      column.custom("cost", (row) => row.cost ?? row.tokens, t("resource.usage.cost"), costCell, {
        width: "w-[32%]",
      }),
      column.custom(
        "runs",
        (row) => runCounts.get(row.key) ?? 0,
        t("resource.usage.runs"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {number.format(runCounts.get(row.key) ?? 0)}
          </span>
        ),
        { width: "w-[16%]" },
      ),
    ];
  }, [t, dateTime, workflowName, costCell, number, runCounts]);

  const modelColumns = useMemo<CockpitColumn<ConsumptionRow>[]>(() => {
    const column = tableColumns<ConsumptionRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => row.name ?? row.key,
        t("resource.usage.axis.model"),
        (row) => (
          <span className="block break-words font-medium" title={row.name ? row.key : undefined}>
            {row.unattributed ? t("resource.usage.unattributed") : (row.name ?? row.key)}
          </span>
        ),
        { width: "w-[70%]" },
      ),
      column.custom(
        "share",
        (row) => row.share,
        t("resource.field.share"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {row.share === null ? MISSING : percent.format(row.share)}
          </span>
        ),
        { width: "w-[30%]" },
      ),
    ];
  }, [t, dateTime, percent]);

  const header = <PageHeader title={title} />;

  if (!allowed)
    return (
      <Page kind="list" surface="collection" testId="resource-usage" scroll="page" header={header}>
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
      </Page>
    );

  const spent = money
    ? currency.format(money.amount)
    : t(pluralKey("resource.usage.tokensAmount", windowTokens), {
        count: number.format(windowTokens),
      });
  const share = budgetPercent(budget);
  const pressure = budgetPressure(budget);
  const capPart = status.error ? (
    <span data-testid="usage-budget-unreadable">{t("resource.usage.budgetUnreadable")}</span>
  ) : budget.budgetTokens === null ? (
    <span data-testid="usage-budget-uncapped">{t("resource.usage.noCap")}</span>
  ) : share !== null && share >= 100 ? (
    <span data-testid="usage-cap-consequence">{t("resource.usage.capReached")}</span>
  ) : share !== null ? (
    pressure === "tightening" || pressure === "critical" ? (
      <a
        className="font-medium text-foreground underline underline-offset-2"
        href={absolute(settingsHref(BUDGET_SETTING))}
        data-testid={`usage-pressure-${pressure}`}
        aria-label={`${t(PRESSURE_LABEL[pressure])} — ${t("resource.usage.raiseCap")}`}
      >
        {t("resource.usage.capShare", { percent: share })}
      </a>
    ) : (
      <span data-testid="usage-cap-share">{t("resource.usage.capShare", { percent: share })}</span>
    )
  ) : null;

  const emptyState = {
    zero: { title: t("resource.usage.consumptionEmpty") },
    filtered: {
      title: t("resource.noMatches"),
      description: t("resource.broaderSearch"),
      resetLabel: t("catalog.clearFilters"),
      onReset: () => {},
    },
  };
  const tableError = (retry: () => void) => ({
    title: t("resource.loadFailed", { resource: title }),
    description: t("resource.loadFailedDescription"),
    retryLabel: t("session.retry"),
    onRetry: retry,
  });

  return (
    <Page kind="list" surface="collection" testId="resource-usage" scroll="page" header={header}>
      <div className="flex flex-col gap-8">
        <SummaryLine
          testId="usage-cap-line"
          text={
            <span data-testid="usage-spend">
              {spent}
              {capPart ? <> · {capPart}</> : null}
            </span>
          }
          help={t("resource.usage.consumptionDescription")}
          aside={
            <SegmentedControl
              label={t("resource.usage.windowPicker")}
              testId="usage-window"
              value={span}
              onValueChange={chooseWindow}
              options={STATS_WINDOWS.map((candidate) => ({
                value: candidate,
                label: t(WINDOW_OPTION[candidate]),
                testId: `usage-window-${candidate}`,
              }))}
            />
          }
        />

        <Section label={t("resource.usage.byOrigin")} testId="usage-origins">
          <DataTable
            collectionId="usage-origin-table"
            collectionTier="embedded"
            columns={originColumns}
            data={origins}
            pending={byFlow.isPending}
            error={byFlow.error ? tableError(() => void byFlow.refetch()) : null}
            emptyState={emptyState}
            hasActiveFilters={false}
            sorting={[] as SortingState}
            onSortingChange={() => {}}
            columnsLabel={`${t("catalog.columns")} · ${t("resource.usage.byOrigin")}`}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </Section>

        {byWorkflow.isPending || byWorkflow.error || attributedRows.length > 0 ? (
          <Section label={t("resource.usage.byWorkflow")} testId="usage-breakdown">
            <DataTable
              collectionId="usage-consumption-table"
              collectionTier="embedded"
              columns={workflowColumns}
              data={attributedRows}
              pending={byWorkflow.isPending}
              error={byWorkflow.error ? tableError(() => void byWorkflow.refetch()) : null}
              emptyState={emptyState}
              hasActiveFilters={false}
              sorting={[] as SortingState}
              onSortingChange={() => {}}
              columnsLabel={`${t("catalog.columns")} · ${t("resource.usage.byWorkflow")}`}
              recordsLabel={t("catalog.records")}
              actionsLabel={t("common.actions")}
            />
          </Section>
        ) : null}

        <Section label={t("resource.usage.byModel")} testId="usage-models">
          <DataTable
            collectionId="usage-model-table"
            collectionTier="embedded"
            columns={modelColumns}
            data={modelRows}
            pending={byModel.isPending}
            error={byModel.error ? tableError(() => void byModel.refetch()) : null}
            emptyState={emptyState}
            hasActiveFilters={false}
            sorting={[] as SortingState}
            onSortingChange={() => {}}
            columnsLabel={`${t("catalog.columns")} · ${t("resource.usage.byModel")}`}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </Section>
      </div>
    </Page>
  );
}
