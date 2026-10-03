import { useQueries, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, settingsHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  type CockpitColumn,
  CollapsibleSection,
  ContextHelp,
  DataState,
  DataTable,
  Page,
  PageHeader,
  Section,
  SegmentedControl,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { canReadDirectory } from "@/pages/audit-model";
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
  windowBucket,
} from "@/pages/operations-figures";
import {
  budgetPressure,
  budgetSummary,
  CONSUMPTION_AXES,
  type ConsumptionAxis,
  type ConsumptionRow,
  consumptionRows,
  formatDurationMs,
  type UsageRow,
  unpricedModels,
  usageRows,
  type WorkflowNameLookup,
  windowCost,
  workflowNameLookup,
} from "@/pages/usage-model";

const AXIS_LABEL: Record<ConsumptionAxis, TranslationKey> = {
  workflow: "resource.usage.axis.workflow",
  flow: "resource.usage.axis.flow",
  user: "resource.usage.axis.user",
  model: "resource.usage.axis.model",
};

/** The setting the cap is, and where every "set / raise the cap" on this page leads. */
const BUDGET_LEAF = BUDGET_SETTING;

const WINDOW_OPTION: Record<StatsWindow, TranslationKey> = {
  "24h": "resource.usage.windowOption.24h",
  "7d": "resource.usage.windowOption.7d",
  "30d": "resource.usage.windowOption.30d",
};

/** The table's rows are hours over a day and days over longer windows; the sentence says which. */
const RUNTIME_DESCRIPTION: Record<"hour" | "day", TranslationKey> = {
  hour: "resource.usage.runtimeDescriptionHourly",
  day: "resource.usage.runtimeDescription",
};

const WINDOW_HEADING: Record<StatsWindow, TranslationKey> = {
  "24h": "resource.usage.runtimeWindow.24h",
  "7d": "resource.usage.runtimeWindow.7d",
  "30d": "resource.usage.runtimeWindow.30d",
};

const PRESSURE_LABEL = {
  ample: "resource.usage.pressure.ample",
  tightening: "resource.usage.pressure.tightening",
  critical: "resource.usage.pressure.critical",
} as const satisfies Record<string, TranslationKey>;

/** The state word each pressure reads as: a dot that says well, tight or nearly gone. */
const PRESSURE_STATE = { ample: "ok", tightening: "warn", critical: "critical" } as const;

/** The summary line's one sentence about the cap, by what is known of it. */
const CAP_LINE: Record<"unreadable" | "uncapped" | "set", { key: TranslationKey; testId: string }> =
  {
    unreadable: { key: "resource.usage.budgetUnreadable", testId: "usage-budget-unreadable" },
    uncapped: { key: "resource.usage.noCapHint", testId: "usage-budget-uncapped" },
    set: { key: "resource.usage.capReached", testId: "usage-cap-consequence" },
  };

function isWindow(value: string): value is StatsWindow {
  return (STATS_WINDOWS as readonly string[]).includes(value);
}

function isAxis(value: string): value is ConsumptionAxis {
  return (CONSUMPTION_AXES as readonly string[]).includes(value);
}

/**
 * One page for two questions in the order a reader asks them: what did this
 * workspace SPEND, and then how long did its runs take.
 *
 * The operating figures — runs, success rate, connector health, repairs — are
 * not here: they are the Übersicht's operations bar, their one place (§0.1).
 *
 * The window is a filter, not a page action (D14): it stands at the right of
 * the summary line and governs every figure below it. The page leads with one
 * table — what the spend went on — and keeps the runtime table collapsed.
 */
export function UsagePage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("stats:read");
  const title = t("resource.usage.title");
  const [axis, setAxis] = useState<ConsumptionAxis>("workflow");
  // One window for the page — the spend, its breakdown and the runtime table.
  // It comes from the address (`?window=24h`), so the Übersicht's cost figure
  // opens this page over the very window it counted (§10.1).
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

  const runtime = useQuery({
    queryKey: ["usage", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(executionStatsEndpoint(bounds)),
  });
  const consumption = useQuery({
    queryKey: ["usage-llm", axis, bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds, axis)),
  });
  // The cap and the remainder. Its own request because it answers about the
  // calendar month while everything else on this page answers about the
  // chosen window — two periods that must not be silently merged.
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(STATUS_ENDPOINT),
  });

  const rows = useMemo(() => usageRows(runtime.data), [runtime.data]);
  const spend = useMemo(() => consumptionRows(consumption.data, axis), [consumption.data, axis]);
  const budget = useMemo(() => budgetSummary(status.data), [status.data]);
  const money = useMemo(() => windowCost(consumption.data), [consumption.data]);
  const missingPrices = useMemo(() => unpricedModels(consumption.data), [consumption.data]);
  // Names for the person axis. `llm_usage` stores a user id and nothing else,
  // so without this the page prints raw UUIDs at a reader. Fetched only when
  // that axis is open.
  const people = useQuery({
    queryKey: ["usage-people"],
    // Only asked when the engine would answer: a refused read is an audit row.
    enabled: allowed && axis === "user" && canReadDirectory(session),
    queryFn: () =>
      apiRequest<{ items?: Array<{ id: string; email?: string; name?: string }> }>(
        "/v1/identity/users?limit=200",
      ),
  });
  const personName = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of people.data?.items ?? []) {
      const label = item.name?.trim() || item.email?.trim();
      if (label) byId.set(item.id, label);
    }
    return byId;
  }, [people.data]);
  // Names for the workflow axis, each id looked up by itself: only a 404 says
  // a workflow is gone; any other failure is a name this page could not read.
  const workflowIds = useMemo(
    () =>
      axis === "workflow" ? spend.filter((row) => !row.unattributed).map((row) => row.key) : [],
    [axis, spend],
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
      const status =
        lookup?.error instanceof ApiError ? lookup.error.status : lookup?.error ? 0 : null;
      byId.set(id, workflowNameLookup(lookup?.data, status));
    });
    return byId;
  }, [workflowIds, workflowLookups]);
  const pressure = budgetPressure(budget);

  const number = useMemo(
    () => new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US"),
    [locale],
  );
  const percent = useMemo(
    () =>
      new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
        style: "percent",
        maximumFractionDigits: 1,
      }),
    [locale],
  );
  const tokens = (value: number | null): string =>
    value === null ? MISSING : number.format(value);

  const spendColumns = useMemo<CockpitColumn<ConsumptionRow>[]>(() => {
    const column = tableColumns<ConsumptionRow>({ t, dateTime });
    return [
      column.custom(
        "key",
        (row) => row.key,
        t(AXIS_LABEL[axis]),
        (row) => {
          if (row.unattributed)
            return (
              <span className="block break-words text-muted-foreground">
                {t("resource.usage.unattributed")}
              </span>
            );
          // A purpose is a fixed vocabulary, so it gets a word. A person gets
          // their name. An id that resolves to neither is never a bare UUID.
          if (axis === "flow") {
            const key = `usage.flow.${row.key}` as TranslationKey;
            const named = t(key);
            return <span className="block break-words">{named === key ? row.key : named}</span>;
          }
          if (axis === "user") {
            const name = personName.get(row.key);
            if (name) return <span className="block break-words">{name}</span>;
            // An unreadable directory cannot name the person; it must not
            // assert the workspace has dropped them.
            const unreadable = Boolean(people.error) || personName.size === 0;
            return (
              <span className="block break-words text-muted-foreground">
                {t(unreadable ? "resource.usage.personUnreadable" : "resource.usage.unknownPerson")}
              </span>
            );
          }
          if (axis === "workflow") {
            const lookup = workflowName.get(row.key);
            const name = lookup?.kind === "named" ? lookup.name : null;
            if (name)
              return (
                <a
                  className="block break-words font-medium underline-offset-4 hover:underline"
                  href={absolute(workflowHref(row.key))}
                  data-testid="usage-workflow-link"
                >
                  {name}
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
          }
          return <span className="block break-words">{row.key}</span>;
        },
        { width: "w-[46%]" },
      ),
      column.custom(
        "tokens",
        (row) => row.tokens,
        t("resource.field.tokens"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">{number.format(row.tokens)}</span>
        ),
        { width: "w-[20%]" },
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
        { width: "w-[17%]" },
      ),
      column.custom(
        "calls",
        (row) => row.calls,
        t("resource.field.calls"),
        (row) => <span className="whitespace-nowrap tabular-nums">{number.format(row.calls)}</span>,
        { width: "w-[17%]" },
      ),
    ];
  }, [t, dateTime, axis, number, percent, personName, people.error, workflowName]);

  const columns = useMemo<CockpitColumn<UsageRow>[]>(() => {
    const column = tableColumns<UsageRow>({ t, dateTime });
    return [
      column.date("date", (row) => row.date, t("resource.field.date"), { width: "w-[34%]" }),
      column.custom(
        "executions",
        (row) => row.executions,
        t("resource.field.executions"),
        (row) => <span className="whitespace-nowrap tabular-nums">{row.executions}</span>,
        { width: "w-[22%]" },
      ),
      column.custom(
        "average_duration_ms",
        (row) => row.average_duration_ms,
        t("resource.field.averageDuration"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatDurationMs(row.average_duration_ms)}
          </span>
        ),
        { width: "w-[22%]" },
      ),
      column.custom(
        "p95_duration_ms",
        (row) => row.p95_duration_ms,
        t("resource.field.p95Duration"),
        (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatDurationMs(row.p95_duration_ms)}
          </span>
        ),
        { width: "w-[22%]" },
      ),
    ];
  }, [t, dateTime]);

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

  const currency = (amount: number, code: string) =>
    new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
      style: "currency",
      currency: code,
    }).format(amount);

  // What the summary line says about the cap: whether one is set, and what
  // happens when it runs out. A failed read is not a configuration fact — it
  // says nothing about whether a cap is set.
  const capState = status.error ? "unreadable" : budget.budgetTokens === null ? "uncapped" : "set";
  const capLine = CAP_LINE[capState];

  return (
    <Page kind="list" surface="collection" testId="resource-usage" scroll="page" header={header}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3" data-testid="usage-consumption">
          <SummaryLine
            testId="usage-cap-line"
            text={<span data-testid={capLine.testId}>{t(capLine.key)}</span>}
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

          {status.isPending ? (
            <DataState state="loading" />
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="usage-budget">
              {/* Money leads when it can be computed; tokens stay as the
                  evidence beside it. With no price for any model used the
                  amount is absent rather than zero — a nought would say the
                  window was free. */}
              <UsageTile
                label={money ? t("resource.usage.spend") : t("resource.usage.monthTokens")}
                value={money ? currency(money.amount, money.currency) : tokens(budget.usedTokens)}
                note={
                  money ? (
                    <span data-testid="usage-spend-basis">
                      {t("resource.usage.spendBasis")}
                      {money.unpricedCalls > 0 ? (
                        <span data-testid="usage-unpriced">
                          {" · "}
                          {t("resource.usage.unpriced", {
                            calls: money.unpricedCalls,
                            models: money.unpricedModels.join(", "),
                          })}
                        </span>
                      ) : null}
                    </span>
                  ) : consumption.error ? (
                    <span data-testid="usage-spend-unreadable">
                      {t("resource.usage.spendUnreadable")}
                    </span>
                  ) : (
                    <span data-testid="usage-no-prices">
                      {missingPrices.length > 0
                        ? t("resource.usage.noPrices", { models: missingPrices.join(", ") })
                        : t("resource.usage.noPricesUnnamed")}
                    </span>
                  )
                }
              />
              {/* The calendar month, only when the first tile is an amount —
                  otherwise that tile already shows this very number. */}
              {money ? (
                <UsageTile
                  label={t("resource.usage.monthTokens")}
                  value={tokens(budget.usedTokens)}
                />
              ) : null}
              <UsageTile
                label={t("resource.usage.cap")}
                value={
                  capState === "unreadable"
                    ? MISSING
                    : capState === "uncapped"
                      ? t("resource.usage.noCap")
                      : tokens(budget.budgetTokens)
                }
                note={
                  capState === "uncapped" ? (
                    <a
                      className="font-medium text-foreground underline underline-offset-2"
                      href={absolute(settingsHref(BUDGET_LEAF))}
                      data-testid="usage-set-cap"
                    >
                      {t("resource.usage.setCap")}
                    </a>
                  ) : capState === "set" && pressure ? (
                    // The cap is a setting; the pressure word opens it.
                    <a
                      href={absolute(settingsHref(BUDGET_LEAF))}
                      data-testid={`usage-pressure-${pressure}`}
                      aria-label={`${t(PRESSURE_LABEL[pressure])} — ${t("resource.usage.raiseCap")}`}
                    >
                      <StatusBadge
                        state={PRESSURE_STATE[pressure]}
                        label={t(PRESSURE_LABEL[pressure])}
                      />
                    </a>
                  ) : null
                }
              />
              {capState === "set" ? (
                <UsageTile
                  label={t("resource.usage.remaining")}
                  value={tokens(budget.remainingTokens)}
                />
              ) : null}
            </div>
          )}
        </div>

        <Section label={t("resource.usage.consumption")} testId="usage-breakdown">
          {/* One axis at a time: four tables side by side would be four
              answers to one question. The breakdown covers the window, the
              tiles the calendar month — two periods, said where the table is
              read. */}
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label={t("resource.usage.axisPicker")}
              testId="usage-axis"
              value={axis}
              onValueChange={(next) => {
                if (isAxis(next)) setAxis(next);
              }}
              options={CONSUMPTION_AXES.map((candidate) => ({
                value: candidate,
                label: t(AXIS_LABEL[candidate]),
                testId: `usage-axis-${candidate}`,
              }))}
            />
            <ContextHelp label={t("resource.usage.consumption")} testId="usage-breakdown-window">
              {t("resource.usage.breakdownWindow")}
            </ContextHelp>
          </div>
          <DataTable
            // Every `data-testid` the table emits derives from `collectionId`,
            // so the two tables on this page each need their own.
            collectionId="usage-consumption-table"
            collectionTier="embedded"
            columns={spendColumns}
            data={spend}
            onRefresh={() => void consumption.refetch()}
            refreshing={consumption.isFetching}
            refreshLabel={t("common.refresh")}
            pending={consumption.isPending}
            error={
              consumption.error
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void consumption.refetch(),
                  }
                : null
            }
            emptyState={{
              zero: { title: t("resource.usage.consumptionEmpty") },
              filtered: {
                title: t("resource.noMatches"),
                description: t("resource.broaderSearch"),
                resetLabel: t("catalog.clearFilters"),
                onReset: () => void consumption.refetch(),
              },
            }}
            hasActiveFilters={false}
            sorting={[] as SortingState}
            onSortingChange={() => {}}
            page={0}
            pageSize={Math.max(spend.length, 1)}
            total={spend.length}
            onPageChange={() => {}}
            previousLabel={t("catalog.previous")}
            nextLabel={t("catalog.next")}
            columnsLabel={t("catalog.columns")}
            recordsLabel={t("catalog.records")}
            loadedLabel={t("catalog.loaded", { count: spend.length })}
            actionsLabel={t("common.actions")}
          />
        </Section>

        {/* How often and how long: the second question, collapsed so the page
            leads with one table. */}
        <CollapsibleSection
          label={`${t("resource.usage.runtime")} · ${t(WINDOW_HEADING[span])}`}
          testId="usage-runtime"
        >
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              {t(RUNTIME_DESCRIPTION[windowBucket(span)])}
            </p>
            <DataTable
              collectionId="usage-runtime-table"
              collectionTier="embedded"
              columns={columns}
              data={rows}
              onRefresh={() => void runtime.refetch()}
              refreshing={runtime.isFetching}
              refreshLabel={t("common.refresh")}
              pending={runtime.isPending}
              error={
                runtime.error
                  ? {
                      title: t("resource.loadFailed", { resource: title }),
                      description: t("resource.loadFailedDescription"),
                      retryLabel: t("session.retry"),
                      onRetry: () => void runtime.refetch(),
                    }
                  : null
              }
              emptyState={{
                zero: { title: t("resource.usage.empty") },
                filtered: {
                  title: t("resource.noMatches"),
                  description: t("resource.broaderSearch"),
                  resetLabel: t("catalog.clearFilters"),
                  onReset: () => void runtime.refetch(),
                },
              }}
              hasActiveFilters={false}
              sorting={[] as SortingState}
              onSortingChange={() => {}}
              page={0}
              pageSize={Math.max(rows.length, 1)}
              total={rows.length}
              onPageChange={() => {}}
              previousLabel={t("catalog.previous")}
              nextLabel={t("catalog.next")}
              columnsLabel={t("catalog.columns")}
              recordsLabel={t("catalog.records")}
              loadedLabel={t("catalog.loaded", { count: rows.length })}
              actionsLabel={t("common.actions")}
            />
          </div>
        </CollapsibleSection>
      </div>
    </Page>
  );
}

/** One figure: its label, the value large, and at most one muted line under it. */
function UsageTile({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border p-3" data-slot="usage-tile">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="truncate font-semibold text-xl tabular-nums">{value}</span>
      {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </div>
  );
}
