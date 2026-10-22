import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useActorDirectory } from "@/app/actor-directory";
import {
  DataState,
  FilterBar,
  InfiniteSentinel,
  RowsSkeleton,
  statusTone,
  TabBody,
  Timeline,
  type TimelineGroup,
} from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { causeClassLabel } from "@/lib/cause-class";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { cn } from "@/lib/utils";
import {
  averageDurationMs,
  type DayLabel,
  groupRunsByDay,
  runStartedAt,
  successRate,
} from "@/lib/workflow-flow";
import {
  failedStatusesFor,
  formatRunDuration,
  isExecutionRecord,
  RUN_STATUSES,
  runCaller,
  runDurationMs,
} from "@/pages/runs-model";

type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];

const PAGE_SIZE = 25;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function useWeek(workflowId: string): {
  total: number | undefined;
  failed: number | undefined;
  summary: string | null;
} {
  const { t } = useI18n();
  const [from] = useState(() => new Date(Date.now() - WEEK_MS).toISOString());
  const scope = `workflow_id=${encodeURIComponent(workflowId)}&started_from=${encodeURIComponent(from)}`;
  const week = useQuery({
    queryKey: ["workflow-runs-week", workflowId, from],
    queryFn: () => apiRequest<ExecutionList>(`/v1/executions?${scope}&limit=1`),
  });
  const failedStatuses = failedStatusesFor("all");
  const failed = useQuery({
    queryKey: ["workflow-runs-week", workflowId, from, failedStatuses],
    queryFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?${scope}&status=${encodeURIComponent(failedStatuses ?? "")}&limit=1`,
      ),
  });
  const summary = weekSummary(week.data?.total, failed.data?.total);
  return {
    total: week.data?.total,
    failed: failed.data?.total,
    summary: summary ? t(summary.key, summary.values) : null,
  };
}

export function weekSummary(
  total: number | undefined,
  failed: number | undefined,
): { key: TranslationKey; values: Record<string, number> } | null {
  if (typeof total !== "number") return null;
  const one = total === 1;
  if (typeof failed !== "number")
    return {
      key: one ? "workflowRuns.weekTotal.one" : "workflowRuns.weekTotal.other",
      values: { count: total },
    };
  return {
    key: one ? "workflowRuns.week.one" : "workflowRuns.week.other",
    values: { count: total, failed },
  };
}

function Tile({
  label,
  value,
  alert,
  testId,
}: {
  label: string;
  value: string;
  alert?: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col rounded-md border px-3 py-2" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn("text-lg font-semibold tabular-nums", alert && "text-destructive")}
        data-slot="tile-value"
      >
        {value}
      </span>
    </div>
  );
}

function useDayLabel(): (label: DayLabel) => string {
  const { t, locale } = useI18n();
  const format = useMemo(
    () =>
      new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
      }),
    [locale],
  );
  return (label) =>
    label.kind === "today"
      ? t("workflowRuns.today")
      : label.kind === "yesterday"
        ? t("workflowRuns.yesterday")
        : format.format(label.date);
}

export function WorkflowRuns({
  workflowId,
  emptyAction,
}: {
  workflowId: string;
  emptyAction?: ReactNode;
}) {
  const { t, locale, dateTime } = useI18n();
  const sheets = useOpenRunSheet();
  const directory = useActorDirectory(true);
  const dayLabel = useDayLabel();
  const [status, setStatus] = useState("all");
  const week = useWeek(workflowId);
  const list = useInfiniteList<ExecutionListItem>(
    "/v1/executions",
    { workflow_id: workflowId, status: status === "all" ? null : status },
    { limit: PAGE_SIZE },
  );
  const { query } = list;
  const rows = list.items.filter((item): item is ExecutionListItem => isExecutionRecord(item));
  const clock = useMemo(
    () => new Intl.DateTimeFormat(LOCALE_TAGS[locale], { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const average = averageDurationMs(rows.map((run) => runDurationMs(run)));
  const rate = successRate(week.total, week.failed);
  const groups: TimelineGroup[] = groupRunsByDay(rows, new Date()).map((group) => ({
    label: dayLabel(group.label),
    items: group.items.map((run, index) => {
      const duration = runDurationMs(run);
      const cause = run.failure?.cause_class;
      const caller = runCaller(run, directory, t);
      const started = runStartedAt(run);
      return {
        id: run.id,
        tone: statusTone(run.status),
        time: clock.format(new Date(started)),
        dateTime: started,
        title: statusLabel(t, run.status),
        meta: cause && cause !== "ok" ? causeClassLabel(cause, t).text : undefined,
        aside: (
          <>
            <span className="hidden w-40 truncate text-right text-xs text-muted-foreground sm:inline">
              {caller.who}
            </span>
            <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
              {duration === null ? "—" : formatRunDuration(locale, duration)}
            </span>
          </>
        ),
        onOpen: () => sheets.run(run.id),
        label: t("workflowRuns.open", {
          when: dateTime(started),
          status: statusLabel(t, run.status),
        }),
        testId: `workflow-run-${group.key}-${index}`,
      };
    }),
  }));
  return (
    <TabBody testId="workflow-history" summary={week.summary ?? t("workflowRuns.title")}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="workflow-runs-tiles">
        <Tile
          label={t("workflowRuns.tile.runs")}
          value={week.total === undefined ? "—" : String(week.total)}
          testId="workflow-runs-tile-runs"
        />
        <Tile
          label={t("workflowRuns.tile.rate")}
          value={rate === null ? "—" : `${rate} %`}
          testId="workflow-runs-tile-rate"
        />
        <Tile
          label={t("workflowRuns.tile.duration")}
          value={average === null ? "—" : formatRunDuration(locale, average)}
          testId="workflow-runs-tile-duration"
        />
        <Tile
          label={t("workflowRuns.tile.failed")}
          value={week.failed === undefined ? "—" : String(week.failed)}
          alert={(week.failed ?? 0) > 0}
          testId="workflow-runs-tile-failed"
        />
      </div>
      <div className="flex flex-col gap-4" data-testid="workflow-recent-runs">
        <FilterBar
          selects={[
            {
              value: status,
              onChange: setStatus,
              label: t("catalog.filterStatus"),
              testId: "workflow-runs-status",
              options: [
                { value: "all", label: t("catalog.allStatuses") },
                ...RUN_STATUSES.map((value) => ({ value, label: statusLabel(t, value) })),
              ],
            },
          ]}
        />
        {query.error ? (
          <DataState
            state="error"
            line={t("runs.detail.loadFailed")}
            onRetry={() => void query.refetch()}
            testId="workflow-runs-error"
          />
        ) : query.isPending ? (
          <RowsSkeleton count={3} testId="workflow-runs-loading" />
        ) : rows.length === 0 ? (
          <DataState
            state="empty"
            line={t(status === "all" ? "detail.noRuns" : "resource.noMatches")}
            action={status === "all" ? emptyAction : undefined}
            testId="workflow-runs-empty"
          />
        ) : (
          <>
            <Timeline groups={groups} testId="workflow-runs-timeline" />
            <InfiniteSentinel infinite={list.infinite} testId="workflow-runs-more" />
          </>
        )}
      </div>
    </TabBody>
  );
}
