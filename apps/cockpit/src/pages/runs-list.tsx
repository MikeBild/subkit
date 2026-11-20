import type { components } from "@cli-core/engine-api/openapi";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiCall } from "@/api/call";
import { absolute, RUNS_FILTER_PARAMS, runHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionButton,
  type CockpitColumn,
  DataTable,
  FilterBar,
  GroupingTabs,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { causeClassLabel } from "@/lib/cause-class";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { windowFilterLabel } from "@/lib/window-filter";
import {
  failedStatusesFor,
  formatRunDuration,
  initialRunsFilter,
  isExecutionRecord,
  REQUEST_SOURCES,
  RUN_STATUSES,
  RUNS_FILTER_KEYS,
  requestSourceLabel,
  runDisplayState,
  runDurationMs,
  runName,
  runsFilterSearch,
  runsSummaryText,
  runsWindowSummaryText,
} from "@/pages/runs-model";

type ExecutionListItem = components["schemas"]["ExecutionListItem"];
const PAGE_SIZE = 25;

export function RunsList({ onShowRun }: { onShowRun(id: string): void }) {
  const { t, tn, dateTime, locale } = useI18n();
  const session = useSession();
  const workflowChoices = useQuery({
    queryKey: ["runs", "workflow-filter-choices"],
    enabled: session.permissions.includes("workflow:read"),
    queryFn: async () => {
      const items: { id: string; name: string }[] = [];
      let total = 1;
      while (items.length < total) {
        const page = await apiCall("get", "/v1/workflows", {
          query: { limit: 200, offset: items.length },
        });
        if (!page.items.length) break;
        items.push(...page.items);
        total = page.total;
      }
      return items;
    },
  });
  const [initial] = useState(() => initialRunsFilter(window.location.search, Date.now()));
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  const [sourceFilter, setSourceFilter] = useState<string>(initial.source);
  const [groupMode, setGroupMode] = useState("all");
  const [search, setSearch] = useState(initial.q);
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(initial.workflowId);
  const [startedWindow, setStartedWindow] = useState<{ from: string | null; to: string | null }>({
    from: initial.startedFrom,
    to: initial.startedTo,
  });
  const debouncedSearch = useDebouncedValue(search);
  const title = t("resource.runs.title");
  const narrowing = {
    request_source: sourceFilter === "all" ? null : sourceFilter,
    workflow_id: workflowFilter,
    q: debouncedSearch.trim() || null,
    started_from: startedWindow.from,
    started_to: startedWindow.to,
  };
  const list = useInfiniteList<ExecutionListItem>(
    "/v1/executions",
    { ...narrowing, status: statusFilter === "all" ? null : statusFilter },
    { limit: PAGE_SIZE },
  );
  const failedStatuses = failedStatusesFor(statusFilter);
  const failedTotal = useQuery({
    queryKey: ["runs", "failed-total", narrowing, failedStatuses],
    enabled: failedStatuses !== null,
    queryFn: ({ signal }) =>
      apiCall("get", "/v1/executions", {
        query: {
          request_source: narrowing.request_source || undefined,
          workflow_id: narrowing.workflow_id || undefined,
          q: narrowing.q || undefined,
          started_from: narrowing.started_from || undefined,
          started_to: narrowing.started_to || undefined,
          status: failedStatuses || undefined,
          limit: 1,
        },
        signal,
      }),
  });
  const failedCount = failedStatuses === null ? 0 : (failedTotal.data?.total ?? null);
  const rows = useMemo(
    () => list.items.filter(isExecutionRecord) as ExecutionListItem[],
    [list.items],
  );

  useEffect(() => {
    const params = new URLSearchParams(
      runsFilterSearch(window.location.search, {
        status: statusFilter,
        source: sourceFilter,
        q: debouncedSearch,
      }),
    );
    for (const [key, value] of [
      [RUNS_FILTER_PARAMS.workflowId, workflowFilter],
      [RUNS_FILTER_PARAMS.startedFrom, startedWindow.from],
      [RUNS_FILTER_PARAMS.startedTo, startedWindow.to],
    ] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const search = params.size ? `?${params.toString()}` : "";
    if (search === window.location.search) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, [statusFilter, sourceFilter, debouncedSearch, workflowFilter, startedWindow]);

  const forgetInAddress = useCallback((keys: readonly string[]) => {
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) params.delete(key);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, []);

  const columns = useMemo<CockpitColumn<ExecutionListItem>[]>(() => {
    const column = tableColumns<ExecutionListItem>({ t, dateTime });
    return [
      column.date("started_at", (run) => run.started_at, t("runs.column.started"), {
        width: "w-[18%]",
      }),
      column.link(
        "workflow",
        (run): Relation | null => ({
          href: run.workflow_id ? absolute(workflowHref(run.workflow_id)) : null,
          label: runName(run, t),
        }),
        t("runs.column.workflow"),
        { width: "w-[26%]" },
      ),
      column.custom(
        "status",
        (run) => runDisplayState(run.status, undefined, run.held_effects),
        t("resource.field.status"),
        (run) => {
          const displayState = runDisplayState(run.status, undefined, run.held_effects);
          return (
            <StatusBadge
              state={displayState === "held" ? "pending" : displayState}
              label={displayState === "held" ? t("runs.list.held") : undefined}
            />
          );
        },
        { width: "w-[16%]" },
      ),
      column.custom(
        "details",
        (run) => run.failure?.cause_class ?? null,
        t("runs.column.details"),
        (run) => {
          const cause = run.failure?.cause_class;
          if (cause && cause !== "ok")
            return (
              <span data-testid="runs-cause">
                <LabelText label={causeClassLabel(cause, t)} />
                <RefusalReasonLine
                  reason={run.failure?.refusal_reason}
                  testId="runs-refusal-reason"
                  className="block text-xs text-muted-foreground"
                />
              </span>
            );
          const ms = runDurationMs(run);
          return (
            <span className="text-muted-foreground">
              {[
                requestSourceLabel(run.request_source, t).text,
                ms === null ? null : formatRunDuration(locale, ms),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          );
        },
        { width: "w-[40%]" },
      ),
    ];
  }, [t, dateTime, locale]);

  const hasActiveFilters =
    Boolean(debouncedSearch.trim()) ||
    statusFilter !== "all" ||
    sourceFilter !== "all" ||
    workflowFilter !== null ||
    startedWindow.from !== null ||
    startedWindow.to !== null;
  const resetFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
    setSourceFilter("all");
    setWorkflowFilter(null);
    setStartedWindow({ from: null, to: null });
    forgetInAddress(RUNS_FILTER_KEYS);
  }, [forgetInAddress]);
  const total = list.total ?? rows.length;
  const sevenDayWindow =
    startedWindow.from !== null &&
    startedWindow.to !== null &&
    Date.parse(startedWindow.to) - Date.parse(startedWindow.from) === 7 * 86_400_000;
  const summary = sevenDayWindow
    ? runsWindowSummaryText(total, failedCount, tn)
    : `${runsSummaryText(total, failedCount, tn)}${startedWindow.from || startedWindow.to ? ` · ${windowFilterLabel(startedWindow.from, startedWindow.to, t, dateTime)}` : ""}`;

  return (
    <div className="flex flex-col gap-6">
      {list.query.data || list.query.isPending ? (
        <SummaryLine text={summary} loading={list.query.isPending} testId="runs-summary" />
      ) : null}
      <div className="flex h-[calc(100dvh-14rem)] min-h-80 flex-col">
        <DataTable
          columns={columns}
          data={rows}
          groupingTabs={
            <GroupingTabs
              label={t("common.groupBy")}
              value={groupMode}
              onChange={setGroupMode}
              options={[
                { value: "all", label: t("common.all") },
                { value: "status", label: t("resource.field.status") },
                { value: "source", label: t("runs.column.source") },
              ]}
              testId="runs-grouping"
              note={groupMode === "all" ? undefined : t("common.loadedOnly")}
            />
          }
          grouping={
            groupMode === "all"
              ? undefined
              : {
                  getKey: (run) =>
                    groupMode === "status"
                      ? runDisplayState(run.status, undefined, run.held_effects) === "held"
                        ? t("runs.list.held")
                        : statusLabel(t, run.status)
                      : requestSourceLabel(run.request_source, t).text,
                }
          }
          toolbar={
            <FilterBar
              search={{
                value: search,
                onChange: setSearch,
                placeholder: t("runs.search"),
                testId: "runs-search",
              }}
              selects={[
                {
                  value: statusFilter,
                  onChange: setStatusFilter,
                  label: t("catalog.filterStatus"),
                  testId: "runs-status-filter",
                  options: [
                    { value: "all", label: t("catalog.allStatuses") },
                    ...RUN_STATUSES.map((status) => ({
                      value: status,
                      label: statusLabel(t, status),
                    })),
                  ],
                },
                {
                  value: sourceFilter,
                  onChange: setSourceFilter,
                  label: t("runs.filterSource"),
                  testId: "runs-source-filter",
                  options: [
                    { value: "all", label: t("common.all") },
                    ...REQUEST_SOURCES.map((source) => ({
                      value: source,
                      label: requestSourceLabel(source, t).text,
                    })),
                  ],
                },
                ...(session.permissions.includes("workflow:read")
                  ? [
                      {
                        value: workflowFilter ?? "all",
                        onChange: (value: string) =>
                          setWorkflowFilter(value === "all" ? null : value),
                        label: t("inbox.resource.workflow"),
                        testId: "runs-workflow-choice",
                        options: [
                          { value: "all", label: t("runs.allWorkflows") },
                          ...(workflowChoices.data ?? []).map((workflow) => ({
                            value: workflow.id,
                            label: workflow.name,
                          })),
                        ],
                      },
                    ]
                  : []),
              ]}
              segmented={
                <>
                  {workflowFilter ? (
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      testId="runs-workflow-filter"
                      onClick={() => {
                        setWorkflowFilter(null);
                        forgetInAddress([RUNS_FILTER_PARAMS.workflowId]);
                      }}
                    >
                      {t("runs.workflowFilter")}
                    </ActionButton>
                  ) : null}
                  {startedWindow.from || startedWindow.to ? (
                    <ActionButton
                      size="sm"
                      variant="ghost"
                      testId="runs-window-filter"
                      onClick={() => {
                        setStartedWindow({ from: null, to: null });
                        forgetInAddress([
                          RUNS_FILTER_PARAMS.startedFrom,
                          RUNS_FILTER_PARAMS.startedTo,
                        ]);
                      }}
                    >
                      {windowFilterLabel(startedWindow.from, startedWindow.to, t, dateTime)}
                    </ActionButton>
                  ) : null}
                </>
              }
            />
          }
          pending={list.query.isPending}
          error={
            list.query.error
              ? {
                  title: t("resource.loadFailed", { resource: title }),
                  description: "",
                  retryLabel: t("pattern.retry"),
                  onRetry: () => void list.query.refetch(),
                }
              : null
          }
          emptyState={{
            zero: { title: t("resource.runs.empty") },
            filtered: {
              title: t("resource.noMatches"),
              description: t("resource.broaderSearch"),
              resetLabel: t("catalog.clearFilters"),
              onReset: resetFilters,
            },
          }}
          hasActiveFilters={hasActiveFilters}
          infinite={list.infinite}
          total={list.total}
          getRowId={(run) => run.id}
          sorting={[]}
          onSortingChange={() => {}}
          onOpen={(run) => onShowRun(run.id)}
          rowHref={(run) => runHref(run.id)}
          linkColumn="started_at"
          columnsLabel={t("catalog.columns")}
          recordsLabel={t("catalog.records")}
          actionsLabel={t("common.actions")}
          collectionId="data-table"
        />
      </div>
    </div>
  );
}
