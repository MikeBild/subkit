import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { PageHeader, Panel } from "@ui/components/proto/Pill";
import { PageSkeleton } from "@ui/components/proto/Skeleton";
import { IconTile } from "@ui/components/proto/visual";
import { Progress } from "@ui/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/ui/tabs";
import { useUi } from "@ui/lib/ui-context";
import { Coins, Gauge } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiCall } from "@/api/call";
import { useSession } from "@/app/session";
import { ActionMenu } from "@/components/cockpit/patterns/action-menu";
import { Button } from "@/components/cockpit/patterns/controls";
import { Screen } from "@/components/cockpit/patterns/screen";
import { SectionHeading } from "@/components/cockpit/patterns/section";
import { ForbiddenState } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import {
  isStatsWindow,
  llmStatsQuery,
  rollingDays,
  usageWindowFromUrl,
  usageWindowSearch,
  type WindowBounds,
  windowBounds,
} from "@/lib/operations-figures";
import { budgetForecast, budgetSummary, llmWindow, windowCost } from "@/lib/usage-model";
import { UsageBreakdown } from "./breakdown";
import { BudgetDialog, CurrencyDialog, ExportDialog, ForecastText } from "./dialogs";
import {
  AREAS,
  AXIS_WIDTH,
  axisNumber,
  budgetView,
  lastDays,
  type UsageTab,
  usageSearch,
  usageTab,
  usageView,
} from "./model";

type UsageDialog = "budget" | "currency" | "export" | null;

function replaceSearch(search: string) {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search}${window.location.hash}`,
  );
}

const axis = { fontSize: 12, fill: "var(--color-muted-foreground)" };
const tip = {
  contentStyle: {
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    fontSize: 12,
    color: "var(--color-popover-foreground)",
  },
  cursor: { fill: "var(--color-muted)", opacity: 0.5 },
};
const AREA_COLOR = {
  workflow: "var(--color-accent)",
  chat: "var(--color-chart-2)",
  other: "var(--color-muted-foreground)",
} as const;

export function UsagePage() {
  const { permissions } = useSession();
  if (!permissions.includes("stats:read"))
    return (
      <Screen testId="usage-page">
        <ForbiddenState />
      </Screen>
    );
  return <UsageScreen />;
}

function UsageScreen() {
  const { t, locale } = useI18n();
  const session = useSession();
  const canWriteSettings = session.permissions.includes("settings:write");
  const canWriteGlobal = canWriteSettings && session.permissions.includes("settings:write:global");
  const { now } = useUi();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const [tab, setTab] = useState<UsageTab>(() => {
    const first = usageTab(search);
    if (new URLSearchParams(search).has("view")) replaceSearch(usageSearch(search, first));
    return first;
  });
  const chooseTab = (next: string) => {
    const value: UsageTab = next === "breakdown" ? "breakdown" : "overview";
    setTab(value);
    replaceSearch(usageSearch(window.location.search, value));
  };
  const [bounds, setBounds] = useState<WindowBounds>(() =>
    windowBounds(usageWindowFromUrl(search)),
  );
  const chooseWindow = (next: string) => {
    if (!isStatsWindow(next)) return;
    setBounds(windowBounds(next));
    replaceSearch(usageWindowSearch(window.location.search, next));
  };
  const [dialog, setDialog] = useState<UsageDialog>(null);
  const span = useMemo(() => lastDays(new Date(now())), [now]);
  const stats = useQuery({
    queryKey: ["usage", "30d", span.from.slice(0, 10)],
    queryFn: () =>
      apiCall("get", "/v1/stats/llm", {
        query: {
          bucket: "day",
          from: span.from,
          to: span.to,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          group_by: "flow",
        },
      }),
  });
  const status = useQuery({
    queryKey: ["usage-status"],
    queryFn: () => apiCall("get", "/v1/status", {}),
  });
  const seven = useMemo(
    () => ({ ...rollingDays(7, new Date(now())), window: "thisWeek" as const }),
    [now],
  );
  const lastSeven = useQuery({
    queryKey: ["usage-llm", "window", seven.from.slice(0, 10)],
    queryFn: () => apiCall("get", "/v1/stats/llm", { query: llmStatsQuery(seven) }),
  });
  const summary = useMemo(() => budgetSummary(status.data), [status.data]);
  const forecast = useMemo(
    () =>
      status.data
        ? budgetForecast({
            usedTokens: summary.usedTokens,
            budgetTokens: summary.budgetTokens,
            lastSevenDaysTokens: llmWindow(lastSeven.data)?.tokens.total ?? null,
            now: new Date(now()),
          })
        : null,
    [status.data, summary, lastSeven.data, now],
  );
  const view = useMemo(() => (stats.data ? usageView(stats.data, span) : null), [stats.data, span]);
  const fmt = useMemo(() => {
    const tag = locale === "de" ? "de-DE" : "en-US";
    const money = new Intl.NumberFormat(tag, {
      style: "currency",
      currency: windowCost(stats.data)?.currency ?? "USD",
    });
    const count = new Intl.NumberFormat(tag);
    return {
      money: (v: number) => money.format(v),
      count: (v: number) => count.format(Math.round(v)),
    };
  }, [locale, stats.data]);
  const value = (v: number) => (view?.measure === "tokens" ? fmt.count(v) : fmt.money(v));
  const budget = budgetView(status.data);
  const dayLabel = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
  });
  const data = (view?.days ?? []).map((d) => ({ ...d, day: dayLabel.format(d.at) }));
  const axisTick = axisNumber(locale === "de" ? "de-DE" : "en-US");
  const perDay = t(view?.measure === "tokens" ? "us.perDayTokens" : "us.perDay");
  return (
    <Screen testId="usage-page">
      <PageHeader
        title={t("us.title")}
        lead={t("us.lead")}
        actions={
          <ActionMenu
            alwaysMenu
            testId="usage-settings-menu"
            label={t("kn.pageMenu")}
            items={[
              {
                label: t("usage.export.open"),
                onSelect: () => setDialog("export"),
                testId: "usage-export",
              },
              ...(canWriteSettings
                ? [
                    {
                      label: t("usage.hint.adjustBudget"),
                      onSelect: () => setDialog("budget"),
                      testId: "usage-menu-budget",
                    },
                    {
                      label: t("usage.currency.action"),
                      onSelect: () => setDialog("currency"),
                      testId: "usage-menu-currency",
                    },
                  ]
                : []),
            ]}
          />
        }
      />
      <Tabs value={tab} onValueChange={chooseTab} className="min-w-0">
        <TabsList className="mb-6">
          <TabsTrigger data-testid="usage-tab-overview" value="overview">
            {t("us.tab.overview")}
          </TabsTrigger>
          <TabsTrigger data-testid="usage-tab-breakdown" value="breakdown">
            {t("us.details")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-0">
          {!view ? (
            stats.isError ? (
              <ErrorNotice
                kind="pageFailed"
                rows={[]}
                primary={{ label: t("kn.retry"), onClick: () => void stats.refetch() }}
              />
            ) : (
              <PageSkeleton shape="chart" />
            )
          ) : (
            <>
              <div className="grid gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_280px]">
                <Panel>
                  <div className="mb-4 flex items-center gap-3">
                    <IconTile icon={Coins} size="sm" />
                    <SectionHeading className="font-semibold">{perDay}</SectionHeading>
                  </div>
                  <div className="h-48" role="img" aria-label={perDay}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="var(--color-border)" />
                        <XAxis
                          dataKey="day"
                          tick={axis}
                          tickLine={false}
                          axisLine={false}
                          interval={4}
                        />
                        <YAxis
                          tick={axis}
                          tickLine={false}
                          axisLine={false}
                          width={AXIS_WIDTH}
                          tickFormatter={axisTick}
                        />
                        <Tooltip {...tip} formatter={(v: number) => value(v)} />
                        <Bar
                          dataKey="cost"
                          name={perDay}
                          fill="var(--color-accent)"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span>
                      {t("us.total")}: <span className="font-mono">{value(view.total)}</span>
                    </span>
                    <span>
                      {t("us.avg")}: <span className="font-mono">{value(view.avg)}</span>
                    </span>
                  </div>
                </Panel>
                <Panel className="flex flex-col">
                  <div className="mb-4 flex items-center gap-3">
                    <IconTile icon={Gauge} size="sm" />
                    <SectionHeading className="font-semibold">{t("us.budget")}</SectionHeading>
                  </div>
                  {budget ? (
                    <>
                      <p className="font-mono text-2xl font-semibold">{budget.pct} %</p>
                      <Progress
                        className="mt-3"
                        value={Math.min(100, budget.pct)}
                        aria-label={t("us.budget")}
                      />
                      <p className="mt-3 text-sm text-muted-foreground">
                        {t("us.used", {
                          used: fmt.count(budget.used),
                          total: fmt.count(budget.total),
                        })}
                      </p>
                      {forecast && forecast.kind !== "uncapped" && (
                        <p className="mt-1 text-sm" data-testid="usage-forecast">
                          <ForecastText forecast={forecast} />
                        </p>
                      )}
                    </>
                  ) : status.isError ? (
                    <p className="text-sm text-muted-foreground">
                      {t("resource.usage.budgetUnreadable")}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("us.noBudget")}</p>
                  )}
                  {canWriteSettings && (
                    <Button
                      data-testid={budget ? "usage-budget-open" : "usage-budget-set"}
                      size="sm"
                      variant="outline"
                      className="mt-auto self-start"
                      onClick={() => setDialog("budget")}
                    >
                      {t(budget ? "usage.hint.adjustBudget" : "resource.usage.setCap")}
                    </Button>
                  )}
                </Panel>
              </div>
              <Panel className="mt-4">
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <IconTile icon={Coins} size="sm" />
                  <SectionHeading className="flex-1 font-semibold">{t("us.byArea")}</SectionHeading>
                  <ul className="flex flex-wrap gap-4 text-xs">
                    {AREAS.map((k) => (
                      <li key={k} className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="size-2 rounded-sm"
                          style={{ background: AREA_COLOR[k] }}
                        />
                        {t(`us.area.${k}`)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="h-48" role="img" aria-label={t("us.byArea")}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--color-border)" />
                      <XAxis
                        dataKey="day"
                        tick={axis}
                        tickLine={false}
                        axisLine={false}
                        interval={4}
                      />
                      <YAxis
                        tick={axis}
                        tickLine={false}
                        axisLine={false}
                        width={AXIS_WIDTH}
                        tickFormatter={axisTick}
                      />
                      <Tooltip {...tip} formatter={(v: number) => value(v)} />
                      {AREAS.map((k, i) => (
                        <Bar
                          key={k}
                          dataKey={k}
                          name={t(`us.area.${k}`)}
                          stackId="a"
                          fill={AREA_COLOR[k]}
                          {...(i === AREAS.length - 1
                            ? { radius: [4, 4, 0, 0] as [number, number, number, number] }
                            : {})}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </>
          )}
        </TabsContent>
        <TabsContent value="breakdown" className="mt-0">
          {tab === "breakdown" && (
            <UsageBreakdown
              bounds={bounds}
              chooseWindow={chooseWindow}
              budget={summary}
              forecast={forecast}
              onBudget={() => setDialog("budget")}
            />
          )}
        </TabsContent>
      </Tabs>
      {dialog === "budget" && (
        <BudgetDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          budget={summary}
          forecast={forecast}
          canWrite={canWriteSettings}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
        />
      )}
      {dialog === "currency" && (
        <CurrencyDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          canWriteGlobal={canWriteGlobal}
          tenantId={session.tenant.id}
        />
      )}
      {dialog === "export" && (
        <ExportDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          bounds={bounds}
        />
      )}
    </Screen>
  );
}
