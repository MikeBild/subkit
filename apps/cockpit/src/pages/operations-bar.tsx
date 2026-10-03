import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { absolute } from "@/app/links";
import { ActionButton, TileSkeleton } from "@/components/cockpit/patterns";
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
  type Read,
  STATUS_ENDPOINT,
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

/** What a figure with nothing to count says instead of a 0. */
const NONE_TEXT: Record<OperatingFigureId, TranslationKey> = {
  runs: "overview.operations.none.runs",
  successRate: "overview.operations.none.successRate",
  connectorHealth: "overview.operations.none.connectorHealth",
  repairRate: "overview.operations.none.repairRate",
  cost: "overview.operations.none.cost",
  // The budget is never "nothing to count": no cap is its own state.
  budget: "overview.operations.uncapped",
};

/** The basis beside a label; the chosen window needs no word, the header names it. */
const BASIS_LABEL: Record<FigureBasis, TranslationKey | null> = {
  window: null,
  now: "overview.operations.current",
  month: "overview.operations.month",
};

const PRESSURE_LABEL = {
  ample: "resource.usage.pressure.ample",
  tightening: "resource.usage.pressure.tightening",
  critical: "resource.usage.pressure.critical",
} as const satisfies Record<string, TranslationKey>;

const PRESSURE_TONE = {
  ample: "text-success",
  tightening: "text-warning",
  critical: "text-destructive",
} as const;

/** Whether the reader may see the bar at all: every figure but one is a stats read. */
export function canReadOperations(permissions: readonly string[]): boolean {
  return permissions.includes("stats:read");
}

/**
 * The reads the six figures are made of, over one fixed window. Runs, success
 * rate, connector health and repair rate are one read — the engine's own count
 * (`GET /v1/stats/operating-figures`), the answer the MCP tool and the
 * operational overview give too. Cost and budget are the reads Nutzung makes.
 * All of them are `stats:read`, like the bar itself.
 */
export function useOperationsFigures(bounds: WindowBounds, permissions: readonly string[]) {
  const can = (permission: string) => permissions.includes(permission);
  const allowed = canReadOperations(permissions);
  const canConnectors = can("connector:read");
  const counts = useQuery({
    queryKey: ["operations-figures", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(operatingFiguresEndpoint(bounds)),
  });

  // The window's model calls and their money — the same query Nutzung makes
  // for the window, without a breakdown axis.
  const spend = useQuery({
    queryKey: ["operations-spend", bounds],
    enabled: allowed,
    queryFn: () => apiRequest<unknown>(llmStatsEndpoint(bounds)),
  });
  // The calendar month against the cap: a month, whatever the window.
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
      budgetSetting: can("settings:write"),
    },
  });
  // Every read has answered — or failed — before any figure is shown: a
  // figure that appears late moves the ones beside it.
  const pending = counts.isPending || spend.isPending || status.isPending;
  // Runs, success rate, connector health and repair rate share one read: a
  // retry on any of them asks it again.
  const retry = (id: OperatingFigureId) => {
    if (id === "cost") void spend.refetch();
    else if (id === "budget") void status.refetch();
    else void counts.refetch();
  };
  return { allowed, figures, pending, retry };
}

/**
 * Six figures — three by two on a desktop, six in a row on a wide screen, two
 * columns on a phone — each a link into the list or page that counts the same
 * thing over the same window (§10.1). Compact on purpose: the attention list
 * below it has to stay on the first screen, and the bar never scrolls sideways.
 */
export function OperationsBar({
  figures,
  pending,
  onRetry,
  ids = OPERATING_FIGURE_IDS,
}: {
  figures: readonly OperatingFigure[];
  pending: boolean;
  onRetry: (id: OperatingFigureId) => void;
  /** The figures shown, in order — the Übersicht leads with four (R1). */
  ids?: readonly OperatingFigureId[];
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
  const tag = locale === "de" ? "de-DE" : "en-US";
  const basis = BASIS_LABEL[figure.basis];
  const label = (
    <p className="truncate text-xs text-muted-foreground">
      {t(FIGURE_LABEL[figure.id])}
      {/* A state measured now, or over the calendar month, not over the window. */}
      {basis ? ` · ${t(basis)}` : null}
    </p>
  );
  const box = "grid min-h-[72px] min-w-0 content-center gap-0.5 rounded-lg border px-3 py-2";
  if (figure.state !== "value") {
    // Two answers that are words, not numbers, and still have somewhere to go:
    // calls without a price lead to Nutzung, which names the models; no cap
    // leads to the setting, for someone who may set one.
    const onward = figure.state === "unpriced" || figure.state === "uncapped" ? figure.href : null;
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
        </p>
      </div>
    );
  }
  const compact = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
  // A partly priced window is a floor, and says so: "mind. 412,87 €".
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
  const detail = figure.budget
    ? figure.budget.remainingTokens === null
      ? null
      : t("overview.operations.remaining", {
          remaining: compact.format(figure.budget.remainingTokens),
        })
    : partial && figure.money
      ? t("overview.operations.unpricedCalls", { calls: figure.money.unpricedCalls })
      : null;
  return (
    <div
      className={box}
      data-testid={`operations-figure-${figure.id}`}
      data-figure-state="value"
      data-family-kpi-id={figure.id}
      data-family-kpi-value={display}
      data-budget-pressure={pressure ?? undefined}
    >
      {label}
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={[
            "truncate text-xl font-semibold leading-7 tabular-nums",
            // The number carries the state only when it needs someone.
            pressure && pressure !== "ample" ? PRESSURE_TONE[pressure] : null,
          ]
            .filter(Boolean)
            .join(" ")}
        >
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
        </span>
        {figure.budget ? (
          <span className="truncate text-xs text-muted-foreground">
            {t("overview.operations.budgetOf", {
              budget: compact.format(figure.budget.budgetTokens),
            })}
          </span>
        ) : null}
      </p>
      {pressure || detail ? (
        <p
          className="truncate text-xs text-muted-foreground"
          data-testid={`operations-figure-${figure.id}-detail`}
        >
          {pressure ? (
            <span className={`font-medium ${PRESSURE_TONE[pressure]}`}>
              {t(PRESSURE_LABEL[pressure])}
            </span>
          ) : null}
          {pressure && detail ? " · " : null}
          {detail}
        </p>
      ) : null}
    </div>
  );
}
