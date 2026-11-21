import { useQuery } from "@tanstack/react-query";
import { apiCall } from "@/api/call";
import { absolute, workflowsHref } from "@/app/links";
import { costTrend, type KpiCard, runTrend, successTrend } from "@/features/operations";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useOperatingFiguresQuery } from "@/lib/operating-figures-query";
import {
  type BudgetHint,
  type FigureBasis,
  llmStatsQuery,
  type OperatingFigure,
  type OperatingFigureId,
  operatingCounts,
  operatingFigures,
  REPAIR_REQUIRED_QUERY,
  type Read,
  repairRequiredCount,
  type StatsWindow,
  type WindowBounds,
  windowSpend,
  windowStatsQuery,
} from "@/lib/operations-figures";
import { budgetSummary } from "@/lib/usage-model";

const FIGURE_LABEL: Record<OperatingFigureId, TranslationKey> = {
  runs: "overview.operations.runs",
  successRate: "overview.operations.successRate",
  connectorHealth: "overview.operations.connectorHealth",
  repairRate: "overview.operations.repairRate",
  cost: "overview.operations.cost",
  budget: "overview.operations.budget",
};

const NONE_TEXT: Record<OperatingFigureId, TranslationKey> = {
  runs: "overview.operations.none.runs",
  successRate: "overview.operations.none.successRate",
  connectorHealth: "overview.operations.none.connectorHealth",
  repairRate: "overview.operations.none.repairRate",
  cost: "overview.operations.none.cost",
  budget: "overview.operations.none.cost",
};

const WINDOW_LABEL: Record<StatsWindow, TranslationKey> = {
  "24h": "overview.operations.windowOption.24h",
  thisWeek: "overview.operations.windowOption.thisWeek",
  lastWeek: "overview.operations.windowOption.lastWeek",
  thisMonth: "overview.operations.windowOption.thisMonth",
  lastMonth: "overview.operations.windowOption.lastMonth",
};

const BASIS_LABEL: Record<Exclude<FigureBasis, "window">, TranslationKey> = {
  now: "overview.operations.current",
};

export function canReadOperations(permissions: readonly string[]): boolean {
  return permissions.includes("stats:read");
}

export function useRepairRequiredCount(permissions: readonly string[]): number | null {
  const query = useQuery({
    queryKey: ["repair-required-count"],
    enabled: permissions.includes("workflow:read"),
    queryFn: () => apiCall("get", "/v1/workflows", { query: REPAIR_REQUIRED_QUERY }),
  });
  return query.isError ? null : repairRequiredCount(query.data);
}

export function RepairRequiredHint({ count }: { count: number | null }) {
  const { tn } = useI18n();
  if (!count || count <= 0) return null;
  return (
    <span data-testid="overview-repair-required">
      <a
        className="font-medium text-foreground underline underline-offset-2"
        href={absolute(workflowsHref({ operatingStatus: "repair_required" }))}
        data-testid="overview-repair-required-link"
      >
        {tn("overview.repairRequired", count)}
      </a>
    </span>
  );
}

export function useOperationsFigures(bounds: WindowBounds, permissions: readonly string[]) {
  const can = (permission: string) => permissions.includes(permission);
  const allowed = canReadOperations(permissions);
  const canConnectors = can("connector:read");
  const counts = useOperatingFiguresQuery(bounds, allowed);

  const spend = useQuery({
    queryKey: ["operations-spend", bounds],
    enabled: allowed,
    queryFn: () => apiCall("get", "/v1/stats/llm", { query: llmStatsQuery(bounds) }),
  });
  const executions = useQuery({
    queryKey: ["operations-run-trend", bounds],
    enabled: allowed,
    queryFn: () =>
      apiCall("get", "/v1/stats/executions", {
        query: { ...windowStatsQuery(bounds), group_by: "status" },
      }),
  });
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiCall("get", "/v1/status", {}),
  });

  const read = <T,>(query: { isError: boolean }, value: T): Read<T> =>
    query.isError ? { state: "failed" } : { state: "answered", value };
  const figures = operatingFigures({
    bounds,
    counts: read(counts, operatingCounts(counts.data)),
    connectorsPermitted: canConnectors,
    spend: read(spend, windowSpend(spend.data)),
    budget: read(status, budgetSummary(status.data)),
    canOpen: {
      runs: can("execution:read"),
      connectors: canConnectors,
      audit: can("audit:read"),
      usage: allowed,
      budgetSetting: can("settings:write:global"),
    },
  });
  const pending = counts.isPending || spend.isPending || status.isPending;
  const retry = (id: OperatingFigureId) => {
    if (id === "cost") void spend.refetch();
    else if (id === "budget") {
      void status.refetch();
      void spend.refetch();
    } else void counts.refetch();
  };
  const countsRead = operatingCounts(counts.data);
  const visuals: FigureVisuals = {
    trends: {
      runs: runTrend(executions.data),
      successRate: successTrend(executions.data),
      cost: costTrend(spend.data),
      budget: costTrend(spend.data),
    },
    connectors: countsRead && canConnectors ? countsRead.connectors : null,
  };
  return { allowed, figures, pending, retry, visuals };
}

export interface FigureVisuals {
  trends: Partial<Record<OperatingFigureId, number[] | null>>;
  connectors: { enabled: number; notOk: number; needsReauth: number } | null;
}

const PRESSURE_TONE = { tightening: "warning", critical: "danger" } as const;

function hintText(hint: BudgetHint | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (!hint) return null;
  if (hint.kind === "share")
    return t("overview.operations.tokenPercent", { percent: hint.percent });
  if (hint.kind === "unreadable") return t("overview.operations.budgetUnreadable");
  return t("overview.operations.uncapped");
}

export function kpiCards(
  figures: readonly OperatingFigure[],
  visuals: FigureVisuals,
  t: ReturnType<typeof useI18n>["t"],
  locale: string,
  window: StatsWindow,
): KpiCard[] {
  const tag = locale === "de" ? "de-DE" : "en-US";
  return figures.map((figure) => {
    const basis = figure.basis === "window" ? WINDOW_LABEL[window] : BASIS_LABEL[figure.basis];
    const label = `${t(FIGURE_LABEL[figure.id])} · ${t(basis)}`;
    const dots = figure.id === "connectorHealth" ? visuals.connectors : null;
    const hint = hintText(figure.hint, t);
    const pressure = figure.hint?.kind === "share" ? figure.hint.pressure : null;
    const tone = pressure && pressure !== "ample" ? PRESSURE_TONE[pressure] : null;
    const link =
      figure.hint?.kind === "uncapped" && figure.hint.href
        ? { label: t("resource.usage.setCap"), href: figure.hint.href }
        : null;
    if (figure.state !== "value")
      return {
        id: figure.id,
        label,
        value: "—",
        note:
          figure.state === "unreadable"
            ? t("overview.operations.unreadable")
            : figure.state === "not_permitted"
              ? t("overview.operations.notPermitted")
              : figure.state === "unpriced"
                ? t("overview.operations.unpriced")
                : t(NONE_TEXT[figure.id]),
        href: figure.state === "unpriced" ? figure.href : null,
        trend: null,
        dots: null,
        detail: hint,
        tone,
        link,
        retry: figure.state === "unreadable",
      };
    const partial = figure.money && figure.money.unpricedCalls > 0;
    const value =
      figure.id === "runs"
        ? new Intl.NumberFormat(tag).format(figure.value)
        : figure.money
          ? `${partial ? `${t("overview.operations.atLeast")} ` : ""}${new Intl.NumberFormat(tag, {
              style: "currency",
              currency: figure.money.currency,
            }).format(figure.value)}`
          : `${figure.value}\u00a0%`;
    const fact =
      figure.detail?.kind === "failures" && figure.detail.count > 0
        ? t("overview.operations.failedCount", { count: figure.detail.count })
        : partial && figure.money
          ? t("overview.operations.unpricedCalls", { calls: figure.money.unpricedCalls })
          : null;
    return {
      id: figure.id,
      label,
      value,
      note: null,
      href: figure.href,
      trend: dots ? null : (visuals.trends[figure.id] ?? null),
      dots,
      detail: [fact, hint].filter(Boolean).join(" · ") || null,
      tone,
      link,
      retry: false,
    };
  });
}
