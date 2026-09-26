import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Cable,
  CircleDot,
  Clock3,
  Database,
  Gauge,
  type LucideIcon,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Workflow,
  XCircle,
} from "lucide-react";
import { apiRequest } from "@/api/client";
import { IconButton } from "@/components/cockpit/icon-button";
import { PageFrame } from "@/components/cockpit/page-frame";
import {
  FamilyCard,
  FamilyKpiCard,
  FamilyKpiGrid,
  FamilyOperationalMeta,
  FamilySection,
} from "@/components/family-ui";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

type ValueState = "observed" | "zero" | "missing" | "stale" | "forbidden";
type Severity = "critical" | "urgent" | "healthy" | "information" | "unknown";
interface Metric {
  id: string;
  value: number | null;
  value_state: ValueState;
  severity: Severity;
  kind: "count" | "ratio" | "duration" | "score" | "currency" | "state";
  drilldown: { path: string };
}
interface Snapshot {
  generated_at: string;
  recommended_refresh_seconds: number;
  snapshot_state: string;
  core: {
    blocked: Metric;
    failing: Metric;
    overdue: Metric;
    other_decisions: Metric;
    health: Metric & { state: "healthy" | "limited" | "critical" | "unknown" };
    data_freshness: Metric & { state: "fresh" | "stale" | "missing" | "forbidden" };
  };
  sections: Array<{
    id: string;
    visualization: "kpi" | "sparkline" | "time-series" | "progress" | "segmented-distribution";
    metrics: Metric[];
    drilldown: { path: string };
  }>;
  audit: { path: "/cockpit/audit"; snapshot_generated_at: string };
}

const CORE_COPY: Record<
  string,
  { label: TranslationKey; tooltip: TranslationKey; link: TranslationKey }
> = {
  "decisions.blocked": {
    label: "operational.core.blocked",
    tooltip: "operational.core.blocked.tooltip",
    link: "operational.core.blocked.open",
  },
  "decisions.failing": {
    label: "operational.core.failing",
    tooltip: "operational.core.failing.tooltip",
    link: "operational.core.failing.open",
  },
  "decisions.overdue": {
    label: "operational.core.overdue",
    tooltip: "operational.core.overdue.tooltip",
    link: "operational.core.overdue.open",
  },
  "decisions.other": {
    label: "operational.core.other",
    tooltip: "operational.core.other.tooltip",
    link: "operational.core.other.open",
  },
  "operations.health": {
    label: "operational.core.health",
    tooltip: "operational.core.health.tooltip",
    link: "operational.core.health.open",
  },
  "data.freshness": {
    label: "operational.core.freshness",
    tooltip: "operational.core.freshness.tooltip",
    link: "operational.core.freshness.open",
  },
};
/**
 * The product metrics whose drilldown actually narrows to what the number
 * counted. Everything else keeps its number and loses its link.
 *
 * `executions.incidents_24h` is the only one: it carries `?status=failed`. The
 * comment in the engine records that this narrowing was the fix for "1
 * incident" pointing at eleven thousand rows — the same reasoning applies to
 * every link that never got one.
 */
const ACTIONABLE_DRILLDOWNS = new Set<string>(["executions.incidents_24h"]);

const METRIC_COPY: Record<string, { label: TranslationKey; tooltip: TranslationKey }> = {
  "automation.active_workflows": {
    label: "operational.metric.activeWorkflows",
    tooltip: "operational.metric.activeWorkflows.tooltip",
  },
  "executions.total_24h": {
    label: "operational.metric.executionVolume",
    tooltip: "operational.metric.executionVolume.tooltip",
  },
  "executions.success_ratio": {
    label: "operational.metric.executionSuccess",
    tooltip: "operational.metric.executionSuccess.tooltip",
  },
  "executions.incidents_24h": {
    label: "operational.metric.productionIncidents",
    tooltip: "operational.metric.productionIncidents.tooltip",
  },
  "executions.trial_failures_24h": {
    label: "operational.metric.trialFailures",
    tooltip: "operational.metric.trialFailures.tooltip",
  },
  "connectors.healthy_ratio": {
    label: "operational.metric.connectorHealth",
    tooltip: "operational.metric.connectorHealth.tooltip",
  },
  "repairs.applied_ratio": {
    label: "operational.metric.repairs",
    tooltip: "operational.metric.repairs.tooltip",
  },
  "skills.reusable": {
    label: "operational.metric.skills",
    tooltip: "operational.metric.skills.tooltip",
  },
};
const SECTION_COPY: Record<string, TranslationKey> = {
  workflows: "operational.section.workflows",
  reliability: "operational.section.reliability",
  connections: "operational.section.connections",
  learning: "operational.section.learning",
};
const ICONS: Record<string, LucideIcon> = {
  "decisions.blocked": ShieldAlert,
  "decisions.failing": XCircle,
  "decisions.overdue": Clock3,
  "decisions.other": CircleDot,
  "operations.health": Activity,
  "data.freshness": Database,
  "automation.active_workflows": Workflow,
  "executions.total_24h": Gauge,
  "executions.success_ratio": Gauge,
  "executions.incidents_24h": ShieldAlert,
  "executions.trial_failures_24h": XCircle,
  "connectors.healthy_ratio": Cable,
  "repairs.applied_ratio": Sparkles,
  "skills.reusable": Sparkles,
};
const CORE_ORDER = [
  "decisions.blocked",
  "decisions.failing",
  "decisions.overdue",
  "decisions.other",
  "operations.health",
  "data.freshness",
];

function primary(snapshot: Snapshot): string {
  if (snapshot.core.health.state === "critical") return "operations.health";
  if ((snapshot.core.blocked.value ?? 0) > 0) return "decisions.blocked";
  // A workflow that runs and fails outranks one waiting to be looked at: it is
  // doing something wrong right now, not waiting for someone.
  if ((snapshot.core.failing.value ?? 0) > 0) return "decisions.failing";
  if ((snapshot.core.overdue.value ?? 0) > 0) return "decisions.overdue";
  if (snapshot.core.data_freshness.state !== "fresh") return "data.freshness";
  if ((snapshot.core.other_decisions.value ?? 0) > 0) return "decisions.other";
  return "operations.health";
}

export function OverviewPage() {
  const { t, dateTime, locale } = useI18n();
  const query = useQuery({
    queryKey: ["operational-overview", "v1"],
    queryFn: () => apiRequest<Snapshot>("/v1/operational-overview"),
    refetchInterval: (state) => (state.state.data?.recommended_refresh_seconds ?? 30) * 1000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
  const snapshot = query.data;
  const core = snapshot
    ? [
        snapshot.core.blocked,
        snapshot.core.failing,
        snapshot.core.overdue,
        snapshot.core.other_decisions,
        snapshot.core.health,
        snapshot.core.data_freshness,
      ]
    : [];
  return (
    <PageFrame
      surface="overview"
      testId="overview-page"
      title={t("nav.overview")}
      description={t("operational.description")}
      scroll="page"
      action={
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-family-last-update>
            {snapshot
              ? t("operational.updated", { value: dateTime(snapshot.generated_at) })
              : t("operational.updated.pending")}
          </span>
          <IconButton
            variant="outline"
            label={t("common.refresh")}
            data-testid="overview-refresh"
            data-family-action="refresh"
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
          </IconButton>
        </div>
      }
    >
      {snapshot ? (
        <div className="flex flex-col gap-6" data-family-state={snapshot.snapshot_state}>
          <FamilyKpiGrid>
            {core.map((metric) => {
              const copy = CORE_COPY[metric.id]!;
              const Icon = ICONS[metric.id] ?? Gauge;
              return (
                <FamilyKpiCard
                  key={metric.id}
                  id={metric.id}
                  label={t(copy.label)}
                  value={
                    metric.id === "operations.health"
                      ? t(`operational.health.${snapshot.core.health.state}`)
                      : format(metric, locale, t)
                  }
                  valueRaw={metric.value}
                  valueState={metric.value_state}
                  severity={metric.severity}
                  tooltip={t(copy.tooltip)}
                  href={metric.drilldown.path}
                  linkLabel={t(copy.link)}
                  icon={<Icon className="size-4" />}
                  status={
                    metric.id === "operations.health"
                      ? t(`operational.health.${snapshot.core.health.state}` as TranslationKey)
                      : metric.id === "data.freshness"
                        ? t(
                            `operational.freshness.${snapshot.core.data_freshness.state}` as TranslationKey,
                          )
                        : undefined
                  }
                  primary={primary(snapshot) === metric.id}
                />
              );
            })}
          </FamilyKpiGrid>
          <FamilySection slot="product-metrics" title={t("operational.product.title")}>
            <div className="grid gap-4 lg:grid-cols-2">
              {snapshot.sections.map((section) => (
                <section key={section.id} data-family-visualization={section.visualization}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold leading-6">
                      {t(SECTION_COPY[section.id] ?? "operational.product.title")}
                    </h2>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {section.metrics.map((metric) => {
                      const copy = METRIC_COPY[metric.id];
                      const Icon = ICONS[metric.id] ?? Gauge;
                      return (
                        <FamilyKpiCard
                          key={metric.id}
                          id={metric.id}
                          label={t(copy?.label ?? "operational.metric.value")}
                          value={format(metric, locale, t)}
                          valueRaw={metric.value}
                          valueState={metric.value_state}
                          severity={metric.severity}
                          tooltip={t(copy?.tooltip ?? "operational.metric.value.tooltip")}
                          // A link only where it leads somewhere that can act
                          // on THIS number. A section header's link was a
                          // word-for-word copy of the sidebar entry beside it,
                          // and most metric links landed on an unfiltered list
                          // that cannot tell the number apart: "execution
                          // success 100%" opened every run including the
                          // successful ones, and production incidents and trial
                          // failures — two numbers whose whole purpose is to be
                          // distinguishable — opened the identical URL.
                          //
                          // The numbers all stay. Only links that answer
                          // nothing go, and none is invented to replace them.
                          {...(ACTIONABLE_DRILLDOWNS.has(metric.id)
                            ? { href: metric.drilldown.path, linkLabel: t("operational.details") }
                            : {})}
                          icon={<Icon className="size-4" />}
                          className="min-h-36"
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </FamilySection>
          <FamilyOperationalMeta
            auditLink={
              <a
                className="font-medium underline underline-offset-4"
                href={snapshot.audit.path}
                data-testid="overview-audit-open"
              >
                {t("operational.audit")}
              </a>
            }
            snapshot={t("operational.snapshot", {
              value: dateTime(snapshot.audit.snapshot_generated_at),
            })}
          />
        </div>
      ) : (
        <Fallback loading={query.isPending} />
      )}
    </PageFrame>
  );
}

function Fallback({ loading }: { loading: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6" data-family-state={loading ? "loading" : "error"}>
      <FamilyKpiGrid>
        {CORE_ORDER.map((id, index) => {
          const copy = CORE_COPY[id]!;
          const Icon = ICONS[id] ?? Gauge;
          return (
            <FamilyKpiCard
              key={id}
              id={id}
              label={t(copy.label)}
              value="—"
              valueRaw={null}
              valueState="missing"
              severity="unknown"
              tooltip={t(copy.tooltip)}
              href={
                id.startsWith("decisions.")
                  ? `/cockpit/decisions?bucket=${id.split(".")[1]}`
                  : "/cockpit/operations"
              }
              linkLabel={t(copy.link)}
              icon={<Icon className="size-4" />}
              status={loading ? t("operational.loading") : t("operational.unavailable")}
              primary={index === 3}
            />
          );
        })}
      </FamilyKpiGrid>
      <FamilySection slot="product-metrics" title={t("operational.product.title")}>
        <FamilyCard data-family-visualization="kpi" className="text-sm text-muted-foreground">
          {loading ? t("operational.loading") : t("operational.unavailable")}
        </FamilyCard>
      </FamilySection>
      <FamilyOperationalMeta
        auditLink={
          <a
            className="font-medium underline underline-offset-4"
            href="/cockpit/audit"
            data-testid="overview-audit-open"
          >
            {t("operational.audit")}
          </a>
        }
        snapshot={loading ? t("operational.loading") : t("operational.unavailable")}
      />
    </div>
  );
}

function format(
  metric: Metric,
  locale: string,
  t: (key: TranslationKey, values?: Record<string, string>) => string,
): string {
  if (
    metric.id === "executions.success_ratio" &&
    metric.value === null &&
    metric.value_state === "missing"
  )
    return t("operational.value.noExecutions");
  if (metric.value === null || metric.value_state === "missing")
    return t("operational.value.unknown");
  if (metric.value_state === "forbidden") return t("operational.value.forbidden");
  if (metric.value_state === "stale") return t("operational.value.stale");
  if (metric.id === "data.freshness" && metric.value === 0) return t("operational.value.current");
  if (metric.kind === "ratio")
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
      metric.value,
    );
  if (metric.kind === "score") return `${new Intl.NumberFormat(locale).format(metric.value)}/100`;
  if (metric.kind === "duration")
    return t("operational.value.seconds", {
      value: new Intl.NumberFormat(locale).format(metric.value),
    });
  return new Intl.NumberFormat(locale).format(metric.value);
}
