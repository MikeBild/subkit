import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { absolute } from "@/app/links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  CONNECTORS_ENABLED_ENDPOINT,
  CONNECTORS_NOT_OK_ENDPOINT,
  executionStatsEndpoint,
  listTotal,
  OPERATING_FIGURE_IDS,
  type OperatingFigure,
  type OperatingFigureId,
  operatingFigures,
  type Read,
  repairStatsEndpoint,
  repairTotals,
  runTotals,
  STATS_WINDOWS,
  type StatsWindow,
  type WindowBounds,
} from "./operations-figures";

const FIGURE_LABEL: Record<OperatingFigureId, TranslationKey> = {
  runs: "overview.operations.runs",
  successRate: "overview.operations.successRate",
  connectorHealth: "overview.operations.connectorHealth",
  repairRate: "overview.operations.repairRate",
};

/** What a figure with nothing to count says instead of a 0. */
const NONE_TEXT: Record<OperatingFigureId, TranslationKey> = {
  runs: "overview.operations.none.runs",
  successRate: "overview.operations.none.successRate",
  connectorHealth: "overview.operations.none.connectorHealth",
  repairRate: "overview.operations.none.repairRate",
};

const WINDOW_OPTION: Record<StatsWindow, TranslationKey> = {
  "24h": "overview.operations.windowOption.24h",
  "7d": "overview.operations.windowOption.7d",
  "30d": "overview.operations.windowOption.30d",
};

/** Whether the reader may see the bar at all: every figure but one is a stats read. */
export function canReadOperations(permissions: readonly string[]): boolean {
  return permissions.includes("stats:read");
}

/**
 * The reads the four figures are made of, over one fixed window. Nothing is
 * asked that the engine would refuse: a refused read is an audit row, so the
 * connector totals are read only by someone who may read connectors.
 */
export function useOperationsFigures(bounds: WindowBounds, permissions: readonly string[]) {
  const can = (permission: string) => permissions.includes(permission);
  const allowed = canReadOperations(permissions);
  const canConnectors = can("connector:read");
  const runs = useQuery({
    queryKey: ["operations-runs", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(executionStatsEndpoint(bounds)),
  });
  // The repair decisions of the same window, per verb — the rows the repair
  // rate's link opens.
  const repairs = useQuery({
    queryKey: ["operations-repairs", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(repairStatsEndpoint(bounds)),
  });
  // Connector health is a state, not a trend: two totals the engine counts.
  const enabled = useQuery({
    queryKey: ["operations-connectors", "enabled"],
    enabled: allowed && canConnectors,
    queryFn: () => apiRequest<unknown>(CONNECTORS_ENABLED_ENDPOINT),
  });
  const notOk = useQuery({
    queryKey: ["operations-connectors", "not_ok"],
    enabled: allowed && canConnectors,
    queryFn: () => apiRequest<unknown>(CONNECTORS_NOT_OK_ENDPOINT),
  });

  const read = <T,>(query: { isError: boolean }, value: T): Read<T> =>
    query.isError ? { state: "failed" } : { state: "answered", value };
  const figures = operatingFigures({
    bounds,
    totals: read(runs, runTotals(runs.data)),
    connectors: canConnectors
      ? enabled.isError || notOk.isError
        ? { state: "failed" }
        : {
            state: "answered",
            value: { enabled: listTotal(enabled.data), notOk: listTotal(notOk.data) },
          }
      : null,
    repairs: read(repairs, repairTotals(repairs.data)),
    canOpen: { runs: can("execution:read"), connectors: canConnectors, audit: can("audit:read") },
  });
  // Every read has answered — or failed — before any figure is shown: a
  // figure that appears late moves the ones beside it.
  const pending =
    runs.isPending ||
    repairs.isPending ||
    (canConnectors && (enabled.isPending || notOk.isPending));
  const retry = (id: OperatingFigureId) => {
    if (id === "connectorHealth") {
      void enabled.refetch();
      void notOk.refetch();
    } else if (id === "repairRate") void repairs.refetch();
    else void runs.refetch();
  };
  return { allowed, figures, pending, retry };
}

/** The window the figures count over: 24 hours, 7 days or 30 days. */
export function WindowSwitch({
  value,
  onChange,
}: {
  value: StatsWindow;
  onChange: (window: StatsWindow) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset
      className="flex flex-wrap gap-2"
      aria-label={t("overview.operations.window")}
      data-testid="operations-window"
    >
      {STATS_WINDOWS.map((candidate) => (
        <Button
          key={candidate}
          size="sm"
          variant={candidate === value ? "default" : "outline"}
          aria-pressed={candidate === value}
          onClick={() => onChange(candidate)}
          data-testid={`operations-window-${candidate}`}
        >
          {t(WINDOW_OPTION[candidate])}
        </Button>
      ))}
    </fieldset>
  );
}

/**
 * Four figures in one row — two by two on a phone — each a link into the list
 * that counts the same rows over the same window (§10.1). Compact on purpose:
 * the attention list below it has to stay on the first screen.
 */
export function OperationsBar({
  figures,
  pending,
  onRetry,
}: {
  figures: readonly OperatingFigure[];
  pending: boolean;
  onRetry: (id: OperatingFigureId) => void;
}) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("overview.operations.label")}
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      data-testid="operations-bar"
      data-family-slot="operations-bar"
    >
      {pending
        ? OPERATING_FIGURE_IDS.map((id) => <Skeleton key={id} className="h-[72px] w-full" />)
        : figures.map((figure) => <Figure key={figure.id} figure={figure} onRetry={onRetry} />)}
    </section>
  );
}

function Figure({
  figure,
  onRetry,
}: {
  figure: OperatingFigure;
  onRetry: (id: OperatingFigureId) => void;
}) {
  const { t, locale } = useI18n();
  const label = (
    <p className="truncate text-xs text-muted-foreground">
      {t(FIGURE_LABEL[figure.id])}
      {/* A state measured now, not over the window. */}
      {figure.current ? ` · ${t("overview.operations.current")}` : null}
    </p>
  );
  const box = "grid min-h-[72px] min-w-0 content-center gap-0.5 rounded-lg border px-3 py-2";
  if (figure.state !== "value")
    return (
      <div
        className={box}
        data-testid={`operations-figure-${figure.id}`}
        data-figure-state={figure.state}
      >
        {label}
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          <span>
            {figure.state === "unreadable"
              ? t("overview.operations.unreadable")
              : figure.state === "not_permitted"
                ? t("overview.operations.notPermitted")
                : t(NONE_TEXT[figure.id])}
          </span>
          {figure.state === "unreadable" ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => onRetry(figure.id)}
              data-testid={`operations-figure-${figure.id}-retry`}
            >
              {t("session.retry")}
            </Button>
          ) : null}
        </p>
      </div>
    );
  const display =
    figure.id === "runs"
      ? new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US").format(figure.value)
      : `${figure.value} %`;
  return (
    <div
      className={box}
      data-testid={`operations-figure-${figure.id}`}
      data-figure-state="value"
      data-family-kpi-id={figure.id}
      data-family-kpi-value={display}
    >
      {label}
      <p className="text-xl font-semibold leading-7 tabular-nums">
        {figure.href ? (
          <a
            className="underline-offset-4 hover:underline"
            href={absolute(figure.href)}
            data-testid={`operations-figure-${figure.id}-link`}
          >
            {display}
          </a>
        ) : (
          display
        )}
      </p>
    </div>
  );
}
