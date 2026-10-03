import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import {
  type CockpitColumn,
  FilterBar,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { runHereHref, useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import { causeClassLabel } from "@/lib/cause-class";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { useInfiniteList } from "@/lib/use-infinite-list";
import {
  FAILED_RUN_STATUSES,
  formatRunDuration,
  isExecutionRecord,
  RUN_STATUSES,
  runDurationMs,
} from "@/pages/runs-model";

type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];

const PAGE_SIZE = 25;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only what is a run. A 200 that carries something else — a proxy's page, a
 * partial row — must not reach the status label, where a missing `status`
 * took the whole page down instead of leaving one line out.
 */
function runsOf(list: ExecutionList | undefined): ExecutionListItem[] {
  return (list?.items ?? []).filter((item): item is ExecutionListItem => isExecutionRecord(item));
}

/** How the last seven days went, in one sentence. */
function useWeek(workflowId: string): string | null {
  const { t } = useI18n();
  const [from] = useState(() => new Date(Date.now() - WEEK_MS).toISOString());
  const week = useQuery({
    queryKey: ["workflow-runs-week", workflowId, from],
    queryFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&started_from=${encodeURIComponent(from)}&limit=100`,
      ),
  });
  if (!week.data) return null;
  const runs = runsOf(week.data);
  const total = week.data.total ?? runs.length;
  const failed = runs.filter((run) => FAILED_RUN_STATUSES.has(run.status)).length;
  return t(total === 1 ? "workflowRuns.week.one" : "workflowRuns.week.other", {
    count: total,
    failed,
  });
}

/**
 * "Verlauf": the runs of this workflow, newest first, each opening its sheet
 * on this page (`?run=`). The engine pages and narrows them.
 */
export function WorkflowRuns({ workflowId }: { workflowId: string }) {
  const { t, dateTime, locale } = useI18n();
  const sheets = useOpenRunSheet();
  const [status, setStatus] = useState("all");
  const summary = useWeek(workflowId);
  const list = useInfiniteList<ExecutionListItem>(
    "/v1/executions",
    { workflow_id: workflowId, status: status === "all" ? null : status },
    { limit: PAGE_SIZE },
  );
  const { query } = list;
  const rows = list.items.filter((item): item is ExecutionListItem => isExecutionRecord(item));
  const columns = useMemo<CockpitColumn<ExecutionListItem>[]>(() => {
    const column = tableColumns<ExecutionListItem>({ t, dateTime });
    return [
      column.date(
        "started_at",
        (run) => run.started_at ?? run.created_at,
        t("runs.column.started"),
        {
          width: "w-[28%]",
        },
      ),
      column.custom(
        "status",
        (run) => run.status,
        t("resource.field.status"),
        (run) => <StatusBadge state={run.status} />,
        { width: "w-[20%]" },
      ),
      column.custom(
        "cause",
        (run) => run.failure?.cause_class ?? null,
        t("runs.column.cause"),
        (run, index) => {
          const cause = run.failure?.cause_class;
          return cause && cause !== "ok" ? (
            <span className="text-muted-foreground">
              <LabelText label={causeClassLabel(cause, t)} />
              <RefusalReasonLine
                reason={run.failure?.refusal_reason}
                testId={`workflow-recent-run-${index}-refusal-reason`}
                className="block text-xs"
              />
            </span>
          ) : null;
        },
        { width: "w-[36%]" },
      ),
      column.custom(
        "duration",
        (run) => runDurationMs(run),
        t("runs.column.duration"),
        (run) => {
          const ms = runDurationMs(run);
          return (
            <span className="tabular-nums">
              {ms === null ? MISSING : formatRunDuration(locale, ms)}
            </span>
          );
        },
        { width: "w-[16%]" },
      ),
    ];
  }, [t, dateTime, locale]);
  return (
    <>
      <SummaryLine text={summary ?? t("workflowRuns.title")} testId="workflow-runs-summary" />
      <div data-testid="workflow-recent-runs">
        <RecordTable
          columns={columns}
          data={rows}
          collectionId="workflow-runs"
          emptyLine={t("detail.noRuns")}
          pending={query.isPending}
          error={
            query.error
              ? { line: t("runs.detail.loadFailed"), onRetry: () => void query.refetch() }
              : null
          }
          toolbar={
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
          }
          onOpen={(run) => sheets.run(run.id)}
          rowHref={(run) => runHereHref(run.id)}
          rowLabel={(run) =>
            t("workflowRuns.open", {
              when: dateTime(run.started_at ?? run.created_at),
              status: statusLabel(t, run.status),
            })
          }
          infinite={list.infinite}
          total={list.total}
          getRowId={(run) => run.id}
        />
      </div>
    </>
  );
}
