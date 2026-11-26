import { useMemo } from "react";
import type { StatsWindow } from "@/features/usage/model/operations-figures";
import type { Trend, UsageOrigin } from "@/features/usage/model/usage-model";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

export const ORIGIN_LABEL: Record<UsageOrigin, TranslationKey> = {
  chat: "resource.usage.origin.chat",
  authoring: "resource.usage.origin.authoring",
  summaries: "resource.usage.origin.summaries",
  reviews: "resource.usage.origin.reviews",
  knowledge: "resource.usage.origin.knowledge",
  workflowRuns: "resource.usage.origin.workflowRuns",
  dictation: "resource.usage.origin.dictation",
  other: "resource.usage.origin.other",
};

export const ORIGIN_HELP: Record<UsageOrigin, TranslationKey> = {
  chat: "usage.originHelp.chat",
  authoring: "usage.originHelp.authoring",
  summaries: "usage.originHelp.summaries",
  reviews: "usage.originHelp.reviews",
  knowledge: "usage.originHelp.knowledge",
  workflowRuns: "usage.originHelp.workflowRuns",
  dictation: "usage.originHelp.dictation",
  other: "usage.originHelp.other",
};

export const ORIGIN_COLOR: Record<UsageOrigin, string> = {
  workflowRuns: "var(--sk-usage-origin-workflow-runs)",
  chat: "var(--sk-usage-origin-chat)",
  authoring: "var(--sk-usage-origin-authoring)",
  summaries: "var(--sk-usage-origin-summaries)",
  knowledge: "var(--sk-usage-origin-knowledge)",
  reviews: "var(--sk-usage-origin-reviews)",
  dictation: "var(--sk-usage-origin-dictation)",
  other: "var(--sk-usage-origin-other)",
};

export const LEGEND_ORDER: readonly UsageOrigin[] = [
  "workflowRuns",
  "chat",
  "authoring",
  "summaries",
  "knowledge",
  "reviews",
  "dictation",
  "other",
];

export const WINDOW_OPTION: Record<StatsWindow, TranslationKey> = {
  "24h": "resource.usage.windowOption.24h",
  thisWeek: "resource.usage.windowOption.thisWeek",
  lastWeek: "resource.usage.windowOption.lastWeek",
  thisMonth: "resource.usage.windowOption.thisMonth",
  lastMonth: "resource.usage.windowOption.lastMonth",
};

export const PREVIOUS_LABEL: Record<StatsWindow, TranslationKey> = {
  "24h": "usage.previous.24h",
  thisWeek: "usage.previous.thisWeek",
  lastWeek: "usage.previous.lastWeek",
  thisMonth: "usage.previous.thisMonth",
  lastMonth: "usage.previous.lastMonth",
};

export interface UsageFormat {
  money(amount: number): string;
  count(value: number): string;
  percent(share: number | null): string;
  dayLabel(date: Date): string;
  hourLabel(date: Date): string;
  dateLabel(iso: string): string;
}

export function useUsageFormat(currency: string): UsageFormat {
  const { locale } = useI18n();
  return useMemo(() => {
    const tag = locale === "de" ? "de-DE" : "en-US";
    const money = new Intl.NumberFormat(tag, { style: "currency", currency });
    const count = new Intl.NumberFormat(tag);
    const percent = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 });
    const day = new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric" });
    const hour = new Intl.DateTimeFormat(tag, { hour: "2-digit" });
    const date = new Intl.DateTimeFormat(tag, { dateStyle: "medium" });
    return {
      money: (amount) => money.format(amount),
      count: (value) => count.format(Math.round(value)),
      percent: (share) => (share === null ? "–" : percent.format(share)),
      dayLabel: (at) => day.format(at),
      hourLabel: (at) => hour.format(at),
      dateLabel: (iso) => (iso ? date.format(new Date(iso)) : "–"),
    };
  }, [locale, currency]);
}

export function TrendText({
  trend,
  window,
  testId,
}: {
  trend: Trend;
  window: StatsWindow;
  testId?: string;
}) {
  const { t } = useI18n();
  const previous = t(PREVIOUS_LABEL[window]);
  if (trend.kind === "more" || trend.kind === "less") {
    const label = t(trend.kind === "more" ? "usage.trend.moreLabel" : "usage.trend.lessLabel", {
      percent: trend.percent,
      previous,
    });
    return (
      <span
        className="whitespace-nowrap tabular-nums"
        title={label}
        data-testid={testId}
        data-trend={trend.kind}
      >
        <span aria-hidden="true">
          {t(trend.kind === "more" ? "usage.trend.more" : "usage.trend.less", {
            percent: trend.percent,
          })}
        </span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  const label =
    trend.kind === "same"
      ? t("usage.trend.sameLabel", { previous })
      : trend.kind === "new"
        ? t("usage.trend.newLabel")
        : t("usage.trend.noneLabel");
  return (
    <span
      className="whitespace-nowrap text-muted-foreground"
      title={trend.kind === "none" ? t("usage.trend.noneHelp") : label}
      data-testid={testId}
      data-trend={trend.kind}
    >
      <span aria-hidden="true">
        {t(
          trend.kind === "same"
            ? "usage.trend.same"
            : trend.kind === "new"
              ? "usage.trend.new"
              : "usage.trend.none",
        )}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function ShareBar({ share, color }: { share: number | null; color?: string }) {
  const width = share === null ? 0 : Math.max(2, Math.round(share * 100));
  return (
    <span
      aria-hidden="true"
      className="relative block h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-foreground"
        style={{ width: `${width}%`, ...(color ? { background: color } : {}) }}
      />
    </span>
  );
}
