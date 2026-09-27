import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
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
import {
  budgetPressure,
  budgetSummary,
  CONSUMPTION_AXES,
  type ConsumptionAxis,
  type ConsumptionRow,
  consumptionRows,
  formatDurationMs,
  llmStatsEndpoint,
  type UsageRow,
  usageRows,
  usageStatsEndpoint,
  usageTotals,
} from "@/pages/usage-model";

const AXIS_LABEL: Record<ConsumptionAxis, TranslationKey> = {
  workflow: "resource.usage.axis.workflow",
  flow: "resource.usage.axis.flow",
  user: "resource.usage.axis.user",
  model: "resource.usage.axis.model",
};

const PRESSURE_LABEL = {
  ample: "resource.usage.pressure.ample",
  tightening: "resource.usage.pressure.tightening",
  critical: "resource.usage.pressure.critical",
} as const satisfies Record<string, TranslationKey>;

/**
 * One page for two questions in the order a reader asks them: what did this
 * workspace SPEND, and then how did those runs behave.
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

  const runtime = useQuery({
    queryKey: ["usage"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(usageStatsEndpoint()),
  });
  const consumption = useQuery({
    queryKey: ["usage-llm", axis],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(axis)),
  });
  // The cap and the remainder. Its own request because it answers about the
  // calendar month while everything else on this page answers about the last
  // thirty days — two windows that must not be silently merged.
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>("/v1/status"),
  });

  const rows = useMemo(() => usageRows(runtime.data), [runtime.data]);
  const totals = useMemo(() => usageTotals(runtime.data), [runtime.data]);
  const spend = useMemo(() => consumptionRows(consumption.data), [consumption.data]);
  const budget = useMemo(() => budgetSummary(status.data), [status.data]);
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
        (row) => <span className="truncate">{row.key || MISSING}</span>,
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
  }, [t, dateTime, axis, number, percent]);

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

  const runtimeCards: Array<[TranslationKey, string]> = [
    ["resource.usage.executions", totals.executions === null ? MISSING : String(totals.executions)],
    ["resource.usage.averageDuration", formatDurationMs(totals.averageDurationMs)],
    ["resource.usage.p95Duration", formatDurationMs(totals.p95DurationMs)],
    [
      "resource.usage.successRate",
      totals.successRatePercent === null ? MISSING : `${totals.successRatePercent}%`,
    ],
  ];

  return (
    <PageFrame
      surface="collection"
      testId="resource-usage"
      title={title}
      description={t("resource.usage.description")}
      scroll="page"
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
                <CardDescription>{t("resource.usage.monthTokens")}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{tokens(budget.usedTokens)}</CardTitle>
              </CardHeader>
              <CardFooter className="flex flex-wrap items-center gap-x-6 gap-y-1 text-muted-foreground text-xs">
                {/* No cap is stated as no cap. A dash here, or a zero, would
                    read as a measurement and tell an operator their workspace
                    is bounded when nothing bounds it. */}
                {budget.budgetTokens === null ? (
                  <span data-testid="usage-budget-uncapped">{t("resource.usage.noCapHint")}</span>
                ) : (
                  <>
                    <span>
                      {t("resource.usage.cap")}: {tokens(budget.budgetTokens)}
                    </span>
                    <span>
                      {t("resource.usage.remaining")}: {tokens(budget.remainingTokens)}
                    </span>
                    {pressure ? (
                      <Badge
                        variant={pressure === "critical" ? "destructive" : "secondary"}
                        data-testid={`usage-pressure-${pressure}`}
                      >
                        {t(PRESSURE_LABEL[pressure])}
                      </Badge>
                    ) : null}
                  </>
                )}
              </CardFooter>
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
                  description: t("resource.emptyDescription"),
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
              openLabel={t("common.open")}
            />
          </div>
        </section>

        <section className="grid gap-3" data-testid="usage-runtime">
          <header className="grid gap-1">
            <h2 className="font-medium text-base">{t("resource.usage.runtime")}</h2>
            <p className="text-muted-foreground text-sm">
              {t("resource.usage.runtimeDescription")}
            </p>
          </header>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="usage-summary">
            {runtime.isPending
              ? [0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 w-full" />)
              : runtimeCards.map(([label, display], index) => (
                  <Card key={label} size="sm" data-testid={`usage-summary-${index}`}>
                    <CardHeader>
                      <CardDescription>{t(label)}</CardDescription>
                      <CardTitle className="text-2xl tabular-nums">{display}</CardTitle>
                    </CardHeader>
                    <CardFooter className="text-muted-foreground text-xs">
                      {t("resource.usage.window")}
                    </CardFooter>
                  </Card>
                ))}
          </div>
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
                  description: t("resource.emptyDescription"),
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
              openLabel={t("common.open")}
            />
          </div>
        </section>
      </div>
    </PageFrame>
  );
}
