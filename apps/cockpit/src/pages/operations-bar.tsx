import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { absolute, workflowsHref } from "@/app/links";
import { ActionButton, KpiTile, TileSkeleton } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  type FigureBasis,
  llmStatsEndpoint,
  OPERATING_FIGURE_IDS,
  type OperatingFigure,
  type OperatingFigureId,
  operatingCounts,
  operatingFigures,
  operatingFiguresEndpoint,
  REPAIR_REQUIRED_ENDPOINT,
  type Read,
  repairRequiredCount,
  STATUS_ENDPOINT,
  type StatsWindow,
  type WindowBounds,
  windowSpend,
} from "./operations-figures";
import { budgetSummary } from "./usage-model";

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
  budget: "overview.operations.uncapped",
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
  month: "overview.operations.month",
};

const PRESSURE_TONE = {
  ample: "text-success",
  tightening: "text-warning",
  critical: "text-destructive",
} as const;

export function canReadOperations(permissions: readonly string[]): boolean {
  return permissions.includes("stats:read");
}

export function useRepairRequiredCount(permissions: readonly string[]): number | null {
  const query = useQuery({
    queryKey: ["repair-required-count"],
    enabled: permissions.includes("workflow:read"),
    queryFn: () => apiRequest<unknown>(REPAIR_REQUIRED_ENDPOINT),
  });
  return query.isError ? null : repairRequiredCount(query.data);
}

export function RepairRequiredHint({ count }: { count: number | null }) {
  const { tn } = useI18n();
  if (!count || count <= 0) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="overview-repair-required">
      <a
        className="font-medium text-foreground underline underline-offset-2"
        href={absolute(workflowsHref({ operatingStatus: "repair_required" }))}
        data-testid="overview-repair-required-link"
      >
        {tn("overview.repairRequired", count)}
      </a>
    </p>
  );
}

export function useOperationsFigures(bounds: WindowBounds, permissions: readonly string[]) {
  const can = (permission: string) => permissions.includes(permission);
  const allowed = canReadOperations(permissions);
  const canConnectors = can("connector:read");
  const counts = useQuery({
    queryKey: ["operations-figures", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(operatingFiguresEndpoint(bounds)),
  });

  const spend = useQuery({
    queryKey: ["operations-spend", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds)),
  });
  const status = useQuery({
    queryKey: ["usage-status"],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(STATUS_ENDPOINT),
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
  return { allowed, figures, pending, retry };
}

export function OperationsBar({
  figures,
  pending,
  onRetry,
  ids = OPERATING_FIGURE_IDS,
  window,
}: {
  figures: readonly OperatingFigure[];
  pending: boolean;
  onRetry: (id: OperatingFigureId) => void;
  ids?: readonly OperatingFigureId[];
  window?: StatsWindow;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("overview.operations.label")}
      className={
        ids.length === 4
          ? "grid grid-cols-2 gap-2 lg:grid-cols-4"
          : "grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6"
      }
      data-testid="operations-bar"
      data-family-slot="operations-bar"
    >
      {pending
        ? ids.map((id) => <TileSkeleton key={id} />)
        : figures.map((figure) => (
            <Figure key={figure.id} figure={figure} window={window} onRetry={onRetry} />
          ))}
    </section>
  );
}

function Figure({
  figure,
  window,
  onRetry,
}: {
  figure: OperatingFigure;
  window?: StatsWindow;
  onRetry: (id: OperatingFigureId) => void;
}) {
  const { t, tn, locale } = useI18n();
  const tag = locale === "de" ? "de-DE" : "en-US";
  const basis =
    figure.basis === "window" ? (window ? WINDOW_LABEL[window] : null) : BASIS_LABEL[figure.basis];
  const label = (
    <>
      {t(FIGURE_LABEL[figure.id])}
      {basis ? ` · ${t(basis)}` : null}
    </>
  );
  if (figure.state !== "value") {
    const onward = figure.state === "unpriced" || figure.state === "uncapped" ? figure.href : null;
    return (
      <KpiTile
        label={label}
        testId={`operations-figure-${figure.id}`}
        data={{ "data-figure-state": figure.state }}
        note={
          <>
            <span>
              {figure.state === "unreadable"
                ? t("overview.operations.unreadable")
                : figure.state === "not_permitted"
                  ? t("overview.operations.notPermitted")
                  : figure.state === "unpriced"
                    ? t("overview.operations.unpriced")
                    : figure.state === "uncapped"
                      ? t("overview.operations.uncapped")
                      : t(NONE_TEXT[figure.id])}
            </span>
            {figure.state === "unreadable" ? (
              <ActionButton
                variant="ghost"
                size="sm"
                onClick={() => onRetry(figure.id)}
                testId={`operations-figure-${figure.id}-retry`}
              >
                {t("session.retry")}
              </ActionButton>
            ) : null}
            {onward ? (
              <a
                className="font-medium text-foreground underline underline-offset-2"
                href={absolute(onward)}
                data-testid={`operations-figure-${figure.id}-link`}
              >
                {t(
                  figure.state === "uncapped"
                    ? "resource.usage.setCap"
                    : "overview.operations.openUsage",
                )}
              </a>
            ) : null}
          </>
        }
      />
    );
  }
  const partial = figure.money && figure.money.unpricedCalls > 0;
  const display =
    figure.id === "runs"
      ? new Intl.NumberFormat(tag).format(figure.value)
      : figure.money
        ? `${partial ? `${t("overview.operations.atLeast")} ` : ""}${new Intl.NumberFormat(tag, {
            style: "currency",
            currency: figure.money.currency,
          }).format(figure.value)}`
        : `${figure.value} %`;
  const pressure = figure.budget?.pressure ?? null;
  const budgetNote = figure.budget
    ? figure.money
      ? t("overview.operations.tokenPercent", { percent: figure.budget.percent })
      : null
    : figure.uncapped
      ? t("overview.operations.uncapped")
      : null;
  const detailText = figure.detail
    ? figure.detail.kind === "failures"
      ? t("overview.operations.failedCount", { count: figure.detail.count })
      : figure.detail.needsReauth === 0
        ? t("overview.operations.allConnected")
        : tn("overview.operations.connectorsSignIn", figure.detail.needsReauth)
    : partial && figure.money
      ? t("overview.operations.unpricedCalls", { calls: figure.money.unpricedCalls })
      : null;
  const detail = [detailText, budgetNote].filter(Boolean).join(" · ") || null;
  return (
    <KpiTile
      label={label}
      testId={`operations-figure-${figure.id}`}
      data={{
        "data-figure-state": "value",
        "data-family-kpi-id": figure.id,
        "data-family-kpi-value": display,
        "data-budget-pressure": pressure ?? undefined,
      }}
      tone={pressure && pressure !== "ample" ? PRESSURE_TONE[pressure] : null}
      value={
        figure.href ? (
          <a
            className="underline-offset-4 hover:underline"
            href={absolute(figure.href)}
            data-testid={`operations-figure-${figure.id}-link`}
          >
            {display}
          </a>
        ) : (
          display
        )
      }
      detail={detail}
      detailTitle={detail ?? undefined}
      detailTestId={`operations-figure-${figure.id}-detail`}
    />
  );
}
