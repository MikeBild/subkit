import { useQueries, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
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
import type { TranslationKey } from "@/lib/i18n";
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
  budgetPercent,
  budgetPressure,
  budgetSummary,
  type ConsumptionRow,
  consumptionRows,
  runsByWorkflow,
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

function isWindow(value: string): value is StatsWindow {
  return (STATS_WINDOWS as readonly string[]).includes(value);
}

/**
 * Nutzung (V8): what the model calls cost over one window, by workflow and by
 * model.
 *
 * The window is a filter, not a page action (D14): it stands at the right of
 * the summary line, and the summary line is the page's one figure — the
 * window's spend and how much of the month's cap is gone. The operating
 * figures (runs, success rate, connector health) are the Übersicht's.
 */
export function UsagePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const live = useLiveQueryOptions();
  const allowed = session.permissions.includes("stats:read");
  const title = t("resource.usage.title");
  // The window comes from the address (`?window=24h`), so a figure elsewhere
  // opens this page over the very window it counted.
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
  // The cap answers about the calendar month, the rest about the window.
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(STATUS_ENDPOINT),
    ...live,
  });

  const workflowRows = useMemo(
    () => consumptionRows(byWorkflow.data, "workflow"),
    [byWorkflow.data],
  );
  const modelRows = useMemo(() => consumptionRows(byModel.data, "model"), [byModel.data]);
  const runCounts = useMemo(() => runsByWorkflow(runs.data), [runs.data]);
  const budget = useMemo(() => budgetSummary(status.data), [status.data]);
  const money = useMemo(() => windowCost(byWorkflow.data), [byWorkflow.data]);
  const windowTokens = useMemo(
    () => workflowRows.reduce((sum, row) => sum + row.tokens, 0),
    [workflowRows],
  );

  // Names for the workflow rows, each id looked up by itself: only a 404
  // says a workflow is gone; any other failure is a name this page could not read.
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

  const workflowColumns = useMemo<CockpitColumn<ConsumptionRow>[]>(() => {
    const column = tableColumns<ConsumptionRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => row.key,
        t("resource.usage.axis.workflow"),
        (row) => {
          if (row.unattributed)
            return (
              <span className="block break-words text-muted-foreground">
                {t("resource.usage.unattributed")}
              </span>
            );
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
      column.custom(
        "cost",
        (row) => row.cost ?? row.tokens,
        t("resource.usage.cost"),
        (row) => (
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
                : t("resource.usage.tokensAmount", { count: number.format(row.tokens) })}
            </span>
          </span>
        ),
        { width: "w-[32%]" },
      ),
      column.custom(
        "runs",
        (row) => runCounts.get(row.key) ?? 0,
        t("resource.usage.runs"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {row.unattributed ? MISSING : number.format(runCounts.get(row.key) ?? 0)}
          </span>
        ),
        { width: "w-[16%]" },
      ),
    ];
  }, [t, dateTime, workflowName, currency, number, runCounts]);

  const modelColumns = useMemo<CockpitColumn<ConsumptionRow>[]>(() => {
    const column = tableColumns<ConsumptionRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => row.key,
        t("resource.usage.axis.model"),
        (row) => (
          <span className="block break-words font-medium">
            {row.unattributed ? t("resource.usage.unattributed") : row.key}
          </span>
        ),
        { width: "w-[70%]" },
      ),
      column.custom(
        "share",
        (row) => row.share,
        t("resource.field.share"),
        // A share of nothing is not nought per cent — the dash says so.
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

  // The page's one figure: the window's spend, then the month's cap.
  const spent = money
    ? currency.format(money.amount)
    : t("resource.usage.tokensAmount", { count: number.format(windowTokens) });
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
      // Close to the cap, the share opens the setting that raises it.
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

  // Neither table filters, so the filtered state never shows; the type asks for it.
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

        <Section label={t("resource.usage.byWorkflow")} testId="usage-breakdown">
          <DataTable
            // Every `data-testid` the table emits derives from `collectionId`,
            // so the two tables on this page each need their own.
            collectionId="usage-consumption-table"
            collectionTier="embedded"
            columns={workflowColumns}
            data={workflowRows}
            pending={byWorkflow.isPending}
            error={byWorkflow.error ? tableError(() => void byWorkflow.refetch()) : null}
            emptyState={emptyState}
            hasActiveFilters={false}
            sorting={[] as SortingState}
            onSortingChange={() => {}}
            columnsLabel={t("catalog.columns")}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </Section>

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
            columnsLabel={t("catalog.columns")}
            recordsLabel={t("catalog.records")}
            actionsLabel={t("common.actions")}
          />
        </Section>
      </div>
    </Page>
  );
}
