import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import { apiRequest } from "@/api/client";
import { useSession } from "@/app/session";
import { type CockpitColumn, DataTable } from "@/components/cockpit/data-table";
import { PageFrame } from "@/components/cockpit/page-frame";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  formatDurationMs,
  type UsageRow,
  usageRows,
  usageStatsEndpoint,
  usageTotals,
} from "@/pages/usage-model";

/** One page for one question: what did this workspace run in the last 30 days. */
export function UsagePage() {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("stats:read");
  const title = t("resource.usage.title");
  const query = useQuery({
    queryKey: ["usage"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(usageStatsEndpoint()),
  });

  const rows = useMemo(() => usageRows(query.data), [query.data]);
  const totals = useMemo(() => usageTotals(query.data), [query.data]);
  const columns = useMemo<CockpitColumn<UsageRow>[]>(() => {
    const column = tableColumns<UsageRow>({ t, dateTime });
    return [
      column.date("date", (row) => row.date, t("resource.field.date"), {
        width: "w-[34%]",
      }),
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

  const cards: Array<[TranslationKey, string]> = [
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
      <div className="grid gap-6">
        <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="usage-summary">
          {query.isPending
            ? [0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 w-full" />)
            : cards.map(([label, display], index) => (
                <Card key={label} size="sm" data-testid={`usage-summary-${index}`}>
                  <CardHeader>
                    <CardDescription>{t(label)}</CardDescription>
                    <CardTitle className="text-2xl tabular-nums">{display}</CardTitle>
                  </CardHeader>
                  <CardFooter className="text-xs text-muted-foreground">
                    {t("resource.usage.window")}
                  </CardFooter>
                </Card>
              ))}
        </section>
        <section className="overflow-hidden rounded-xl border">
          <DataTable
            columns={columns}
            data={rows}
            onRefresh={() => void query.refetch()}
            refreshing={query.isFetching}
            refreshLabel={t("common.refresh")}
            pending={query.isPending}
            error={
              query.error
                ? {
                    title: t("resource.loadFailed", { resource: title }),
                    description: t("resource.loadFailedDescription"),
                    retryLabel: t("session.retry"),
                    onRetry: () => void query.refetch(),
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
                onReset: () => void query.refetch(),
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
        </section>
      </div>
    </PageFrame>
  );
}
