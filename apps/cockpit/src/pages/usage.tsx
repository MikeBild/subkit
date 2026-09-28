import { useQueries, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { ApiError, apiRequest } from "@/api/client";
import { absolute, settingsHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { type CockpitColumn, DataTable } from "@/components/cockpit/data-table";
import { PageFrame } from "@/components/cockpit/page-frame";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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

/**
 * One page for two questions in the order a reader asks them: what did this
 * workspace SPEND, and then how long did its runs take.
 *
 * The operating figures — runs, success rate, connector health, repairs — are
 * not here: they are the Übersicht's operations bar, their one place (§0.1).
 *
 * It used to answer only the second. The page was called "Usage", showed
 * executions, duration, p95 and success rate, and read `/v1/stats/executions`
 * — so the one screen named after consumption contained no consumption. The
 * engine had been measuring tokens per model, per purpose, per person and per
 * workflow the whole time.
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
  const chooseWindow = (next: StatsWindow) => {
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
  // so without this the page prints raw UUIDs at a reader — which UI-UX.md
  // forbids outright and which nobody can act on: an operator cannot tell
  // whose spend they are looking at, which is the only reason to group by
  // person at all. Fetched only when that axis is open.
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
  // Names for the workflow axis. `llm_usage` is attributed through the run,
  // so the key is the workflow's id. Each id on screen is looked up by itself:
  // a list capped at 200 called every workflow past the cap "no longer
  // kept". Only a 404 says a workflow is gone; any other failure is a name
  // this page could not read.
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
              <span className="truncate text-muted-foreground">
                {t("resource.usage.unattributed")}
              </span>
            );
          // A purpose is a fixed vocabulary, so it gets a word. A person gets
          // their name. An id that resolves to neither is shown as a person
          // this build cannot name — never as a bare UUID, which says nothing
          // a reader can act on.
          if (axis === "flow") {
            const key = `usage.flow.${row.key}` as TranslationKey;
            const named = t(key);
            return <span className="truncate">{named === key ? row.key : named}</span>;
          }
          if (axis === "user") {
            const name = personName.get(row.key);
            if (name) return <span className="truncate">{name}</span>;
            // Two reasons a name is missing, and they are not the same claim.
            // If the directory could not be read — no permission, a failed
            // request, or a spender beyond the page limit — this build cannot
            // name the person; it must not assert the workspace has dropped
            // them. Either way no raw id reaches the screen.
            const unreadable = Boolean(people.error) || personName.size === 0;
            return (
              <span className="truncate text-muted-foreground">
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
                  className="truncate underline-offset-2 hover:underline"
                  href={absolute(workflowHref(row.key))}
                  data-testid="usage-workflow-link"
                >
                  {name}
                </a>
              );
            if (!lookup || lookup.kind === "pending") return MISSING;
            return (
              <span className="truncate text-muted-foreground">
                {t(
                  lookup.kind === "gone"
                    ? "resource.usage.unknownWorkflow"
                    : "resource.usage.workflowUnreadable",
                )}
              </span>
            );
          }
          return <span className="truncate">{row.key}</span>;
        },
        { width: "w-[46%]" },
      ),
      column.custom(
        "tokens",
        (row) => row.tokens,
        t("resource.field.tokens"),
        (row) => <span className="tabular-nums">{number.format(row.tokens)}</span>,
        { width: "w-[20%]" },
      ),
      column.custom(
        "share",
        (row) => row.share,
        t("resource.field.share"),
        // A share of nothing is not nought per cent — there was nothing to
        // take a share of, and the dash says so.
        (row) => (
          <span className="tabular-nums">
            {row.share === null ? MISSING : percent.format(row.share)}
          </span>
        ),
        { width: "w-[17%]" },
      ),
      column.custom(
        "calls",
        (row) => row.calls,
        t("resource.field.calls"),
        (row) => <span className="tabular-nums">{number.format(row.calls)}</span>,
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
        (row) => <span className="tabular-nums">{row.executions}</span>,
        { width: "w-[22%]" },
      ),
      column.custom(
        "average_duration_ms",
        (row) => row.average_duration_ms,
        t("resource.field.averageDuration"),
        (row) => <span className="tabular-nums">{formatDurationMs(row.average_duration_ms)}</span>,
        { width: "w-[22%]" },
      ),
      column.custom(
        "p95_duration_ms",
        (row) => row.p95_duration_ms,
        t("resource.field.p95Duration"),
        (row) => <span className="tabular-nums">{formatDurationMs(row.p95_duration_ms)}</span>,
        { width: "w-[22%]" },
      ),
    ];
  }, [t, dateTime]);

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-usage">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <PageFrame
      surface="collection"
      testId="resource-usage"
      title={title}
      scroll="page"
      action={
        // One window for the whole page, in its header like the Übersicht's.
        <fieldset
          className="flex flex-wrap gap-2"
          aria-label={t("resource.usage.windowPicker")}
          data-testid="usage-window"
        >
          {STATS_WINDOWS.map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={candidate === span ? "default" : "outline"}
              aria-pressed={candidate === span}
              onClick={() => chooseWindow(candidate)}
              data-testid={`usage-window-${candidate}`}
            >
              {t(WINDOW_OPTION[candidate])}
            </Button>
          ))}
        </fieldset>
      }
    >
      <div className="grid gap-8">
        <section className="grid gap-3" data-testid="usage-consumption">
          <header className="grid gap-1">
            <h2 className="font-medium text-base">{t("resource.usage.consumption")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("resource.usage.consumptionDescription")}
            </p>
          </header>

          {status.isPending ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <Card size="sm" data-testid="usage-budget">
              <CardHeader>
                {/* Money leads when it can be computed; tokens stay as the
                    evidence beside it. When no model used had a price the
                    amount is absent rather than zero — a nought here would
                    tell an operator the month was free — and the unpriced
                    models are named, since SubKit ships list prices and the
                    gap is those models, not pricing as a whole. */}
                <CardDescription>
                  {money ? t("resource.usage.spend") : t("resource.usage.monthTokens")}
                </CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {money
                    ? new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
                        style: "currency",
                        currency: money.currency,
                      }).format(money.amount)
                    : tokens(budget.usedTokens)}
                </CardTitle>
                {money ? (
                  // The amount covers the chosen window; `usedTokens` is
                  // the CALENDAR month, from a different endpoint. Printing
                  // them on one line joined by a dot stated two measurements
                  // over two windows as one — on the first of a month it read
                  // "€412.87 · 0 Tokens". The page's own comment above the
                  // status query says these must not be silently merged, and
                  // this line was the merge. The window is now named.
                  <p className="text-muted-foreground text-xs" data-testid="usage-spend-basis">
                    {t(WINDOW_HEADING[span])} · {t("resource.usage.spendBasis")}
                  </p>
                ) : consumption.error ? (
                  <p className="text-muted-foreground text-xs" data-testid="usage-spend-unreadable">
                    {t("resource.usage.spendUnreadable")}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs" data-testid="usage-no-prices">
                    {missingPrices.length > 0
                      ? t("resource.usage.noPrices", { models: missingPrices.join(", ") })
                      : t("resource.usage.noPricesUnnamed")}
                  </p>
                )}
                {/* What the amount does NOT cover, said out loud. An amount
                    that silently omits calls looks complete. */}
                {money && money.unpricedCalls > 0 ? (
                  <p className="text-muted-foreground text-xs" data-testid="usage-unpriced">
                    {t("resource.usage.unpriced", {
                      calls: money.unpricedCalls,
                      models: money.unpricedModels.join(", "),
                    })}
                  </p>
                ) : null}
              </CardHeader>
              <CardFooter className="flex flex-wrap items-center gap-x-6 gap-y-1 text-muted-foreground text-xs">
                {/* No cap is stated as no cap. A dash here, or a zero, would
                    read as a measurement and tell an operator their workspace
                    is bounded when nothing bounds it. */}
                {/* A failed request is not a configuration fact. React Query
                    clears `isPending` once a query errors, so without this the
                    page told an operator "nothing limits this workspace" —
                    and to go and set a cap — when all that happened was a
                    failed HTTP call. */}
                {status.error ? (
                  <span data-testid="usage-budget-unreadable">
                    {t("resource.usage.budgetUnreadable")}
                  </span>
                ) : budget.budgetTokens === null ? (
                  <span data-testid="usage-budget-uncapped">
                    {t("resource.usage.noCapHint")}{" "}
                    <a
                      className="font-medium text-foreground underline underline-offset-2"
                      href={absolute(settingsHref(BUDGET_LEAF))}
                      data-testid="usage-set-cap"
                    >
                      {t("resource.usage.setCap")}
                    </a>
                  </span>
                ) : (
                  <>
                    {/* Only when the title is an AMOUNT. With no rates the
                        title already shows this very number, and repeating it
                        here was the duplicate display this cockpit keeps
                        removing — introduced by the same change that split the
                        two windows apart. */}
                    {money ? (
                      <span>
                        {t("resource.usage.monthTokens")}: {tokens(budget.usedTokens)}
                      </span>
                    ) : null}
                    <span>
                      {t("resource.usage.cap")}: {tokens(budget.budgetTokens)}
                    </span>
                    <span>
                      {t("resource.usage.remaining")}: {tokens(budget.remainingTokens)}
                    </span>
                    {pressure ? (
                      // Red with its way to the cause (§1): the cap is a
                      // setting, and the badge opens it.
                      <a
                        href={absolute(settingsHref(BUDGET_LEAF))}
                        data-testid={`usage-pressure-${pressure}`}
                        aria-label={`${t(PRESSURE_LABEL[pressure])} — ${t("resource.usage.raiseCap")}`}
                      >
                        <Badge variant={pressure === "critical" ? "destructive" : "secondary"}>
                          {t(PRESSURE_LABEL[pressure])}
                        </Badge>
                      </a>
                    ) : null}
                  </>
                )}
              </CardFooter>
              {!status.error && budget.budgetTokens !== null ? (
                <p
                  className="px-4 pb-3 text-muted-foreground text-xs"
                  data-testid="usage-cap-consequence"
                >
                  {t("resource.usage.capReached")}
                </p>
              ) : null}
            </Card>
          )}

          {/* One axis at a time. Four tables side by side would be four
              answers to one question; the chips make the reader say which
              question they are asking. */}
          <div className="flex flex-wrap gap-2" data-testid="usage-axis">
            {CONSUMPTION_AXES.map((candidate) => (
              <Button
                key={candidate}
                size="sm"
                variant={candidate === axis ? "default" : "outline"}
                onClick={() => setAxis(candidate)}
                data-testid={`usage-axis-${candidate}`}
              >
                {t(AXIS_LABEL[candidate])}
              </Button>
            ))}
          </div>

          {/* The breakdown's window, said where the breakdown is read.
              Production showed "Diesen Monat verbraucht 39.847.696" and,
              immediately below, one row totalling 40.626.498 at "100 %" — both
              figures correct, over two different periods, with nothing on
              screen saying so. A reader takes the table for a decomposition of
              the number above it and finds it does not add up. Naming the
              window is cheaper than making the two agree, and truer: the
              calendar month is what a cap is spent against, the window is
              what a trend is read from. */}
          <p className="text-muted-foreground text-xs" data-testid="usage-breakdown-window">
            {t("resource.usage.breakdownWindow", { window: t(WINDOW_HEADING[span]) })}
          </p>

          <div className="overflow-hidden rounded-xl border">
            <DataTable
              // A second table on one page needs its own identity. Every
              // `data-testid` this component emits derives from
              // `collectionId`, so two tables sharing the default would give
              // one page two elements called `data-table-refresh` — which is
              // exactly how the visual sweep found this.
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
                zero: {
                  title: t("resource.usage.consumptionEmpty"),
                },
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
          </div>
        </section>

        <section className="grid gap-3" data-testid="usage-runtime">
          <header className="grid gap-1">
            {/* The window, said once for the whole block. */}
            <h2 className="font-medium text-base" data-testid="usage-runtime-heading">
              {t("resource.usage.runtime")}{" "}
              <span className="font-normal text-muted-foreground">· {t(WINDOW_HEADING[span])}</span>
            </h2>
            <p className="text-muted-foreground text-sm">
              {t(RUNTIME_DESCRIPTION[windowBucket(span)])}
            </p>
          </header>
          <div className="overflow-hidden rounded-xl border">
            <DataTable
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
                zero: {
                  title: t("resource.usage.empty"),
                },
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
        </section>
      </div>
    </PageFrame>
  );
}
