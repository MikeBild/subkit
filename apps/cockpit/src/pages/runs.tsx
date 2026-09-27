import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, runHref, runsHref, workflowHref, workflowsHref } from "@/app/links";
import { useRecordCrumb } from "@/app/record-crumb";
import { useSession } from "@/app/session";
import { type CockpitColumn, DataTable } from "@/components/cockpit/data-table";
import { PageFrame } from "@/components/cockpit/page-frame";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  executionsQuery,
  filterFromUrl,
  formatRunDuration,
  isExecutionRecord,
  previewText,
  REQUEST_SOURCES,
  RUN_STATUSES,
  type RunFact,
  requestSourceLabel,
  runAuthorityFacts,
  runCostFacts,
  runDurationMs,
  runIdFromPath,
  runName,
  SOURCE_KIND_KEYS,
} from "@/pages/runs-model";

// Re-exported so callers that already know these names keep working; the
// definitions live in the pure model module beside its test.
export { formatRunDuration, RUN_STATUSES, requestSourceLabel, runDurationMs, runName };

type Execution = components["schemas"]["Execution"];
type ExecutionList = components["schemas"]["ExecutionListResponse"];
type ExecutionStep = components["schemas"]["ExecutionStep"];
type ExecutionStepList = components["schemas"]["ExecutionStepListResponse"];

const PAGE_SIZE = 25;

function EvidenceBlock({
  title,
  text,
  tone,
  testId,
}: {
  title: string;
  text: string;
  tone: "error" | "result";
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <pre
        className={`rounded-lg border p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap ${
          tone === "error" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"
        }`}
        data-testid={testId}
      >
        {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
      </pre>
    </section>
  );
}

function RunDetail({ run }: { run: Execution }) {
  const { t, dateTime, locale } = useI18n();
  const detail = useQuery({
    queryKey: ["run", run.id],
    queryFn: () => apiRequest<Execution>(`/v1/executions/${encodeURIComponent(run.id)}`),
  });
  const steps = useQuery({
    queryKey: ["run-steps", run.id],
    queryFn: () =>
      apiRequest<ExecutionStepList>(`/v1/executions/${encodeURIComponent(run.id)}/steps`),
  });
  // What this run consumed. The endpoint has existed since the August cost
  // investigation and no cockpit screen had ever called it, so "what did that
  // run cost" was answerable only from the terminal.
  const cost = useQuery({
    queryKey: ["run-cost", run.id],
    queryFn: () => apiRequest<unknown>(`/v1/executions/${encodeURIComponent(run.id)}/cost`),
  });
  // The list row is the floor: a refresh that did not return an execution
  // leaves the record the reader already had, instead of replacing it with
  // whatever answered 200.
  const current = isExecutionRecord(detail.data) ? detail.data : run;
  const stepItems: ExecutionStep[] = steps.data?.items ?? [];
  const failedStep = stepItems.find((step) => previewText(step.error) !== null);
  const errorEvidence = failedStep ? previewText(failedStep.error) : null;
  const resultStep = [...stepItems]
    .reverse()
    .find((step) => previewText(step.output_preview ?? step.result_preview) !== null);
  const resultEvidence = resultStep
    ? previewText(resultStep.output_preview ?? resultStep.result_preview)
    : null;
  const facts: RunFact[] = [
    [t("resource.field.status"), statusLabel(t, current.status)],
    [t("runs.column.started"), current.started_at ? dateTime(current.started_at) : MISSING],
    [t("runs.detail.finished"), current.finished_at ? dateTime(current.finished_at) : MISSING],
    [
      t("runs.column.duration"),
      runDurationMs(current) === null
        ? MISSING
        : formatRunDuration(locale, runDurationMs(current) ?? 0),
    ],
    [t("runs.column.source"), <LabelText label={requestSourceLabel(current.request_source, t)} />],
    [t("resource.field.kind"), t(SOURCE_KIND_KEYS[current.source_kind] ?? "runs.sourceKind.saved")],
    ...runAuthorityFacts(current, t),
    ...runCostFacts(cost.data, t, locale),
  ];

  return (
    <div className="grid gap-5 p-4">
      <dl className="grid grid-cols-2 gap-3" data-testid="run-detail-facts">
        {facts.map(([label, value, full]) => (
          <div key={label} className="grid gap-1 border-b pb-2">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            {/* `title` only where the row shows a shortened identifier — the
                whole value has to stay copyable, but a tooltip repeating text
                that is already fully on screen is noise. */}
            <dd className="text-sm break-words" title={full}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {detail.error || steps.error ? (
        <Alert variant="destructive" data-testid="run-detail-error-state">
          <AlertTitle>{t("runs.detail.loadFailed")}</AlertTitle>
          <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="run-detail-retry"
            onClick={() => {
              void detail.refetch();
              void steps.refetch();
            }}
          >
            {t("session.retry")}
          </Button>
        </Alert>
      ) : steps.isPending ? (
        <div className="grid gap-3" data-testid="run-detail-loading">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          {errorEvidence && (
            <EvidenceBlock
              title={t("tool.error")}
              text={errorEvidence}
              tone="error"
              testId="run-detail-error"
            />
          )}
          {resultEvidence && (
            <EvidenceBlock
              title={t("tool.result")}
              text={resultEvidence}
              tone="result"
              testId="run-detail-result"
            />
          )}
          <section className="grid gap-2" data-testid="run-detail-steps">
            <h3 className="text-sm font-medium">{t("runs.detail.steps")}</h3>
            {stepItems.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="run-detail-no-steps">
                {t("runs.detail.noSteps")}
              </p>
            ) : (
              stepItems.map((step, index) => {
                const stepError = previewText(step.error);
                return (
                  <div
                    key={`${step.step_key}-${index}`}
                    className="rounded-lg border p-3"
                    data-testid={`run-detail-step-${index}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-medium">{step.step_key}</p>
                      <Badge variant="outline">{statusLabel(t, step.status)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {step.duration_ms === null
                        ? MISSING
                        : formatRunDuration(locale, step.duration_ms)}
                    </p>
                    {stepError && (
                      <pre className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                        {hideTechnicalIdentifiers(stepError, t("tool.referenceHiddenInline"))}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function RunsPage() {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  // Called with the search string explicitly. Handing the function itself to
  // `useState` would invoke it with no argument, and a filter read from
  // nothing is an empty filter — the link would arrive and change nothing,
  // which is the exact failure this parameter exists to prevent.
  const [initial] = useState(() => filterFromUrl(window.location.search));
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  const [sourceFilter, setSourceFilter] = useState<string>(initial.source);
  const [search, setSearch] = useState(initial.q);
  // A link that knows the workflow narrows by its id. It arrives from a
  // decision or a workflow page and is never typed, so it has no control of
  // its own — only the chip below that says so and lifts it.
  const [workflowFilter, setWorkflowFilter] = useState<string | null>(initial.workflowId);
  const [page, setPage] = useState(0);
  // The run the address names. It was a `useState<Execution | null>` holding
  // the row itself, which is why nothing outside this component could ever
  // open one: the only way in was a click, and local state has no address.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    runIdFromPath(window.location.pathname),
  );
  const debouncedSearch = useDebouncedValue(search);
  const allowed = session.permissions.includes("execution:read");
  const title = t("resource.runs.title");
  const needle = debouncedSearch.trim();
  const query = useQuery({
    // The needle is part of the key: it is a filter the engine applies, so a
    // changed needle is a different question and gets its own answer.
    queryKey: ["runs", statusFilter, sourceFilter, workflowFilter, needle, page],
    enabled: allowed,
    queryFn: () => {
      const params = executionsQuery(
        { status: statusFilter, source: sourceFilter, workflowId: workflowFilter, q: needle },
        { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      );
      return apiRequest<ExecutionList>(`/v1/executions?${params}`);
    },
  });
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? rows.length;

  const rowForId = selectedId ? (rows.find((run) => run.id === selectedId) ?? null) : null;
  // A run reached by its address need not be among the rows on screen: a
  // different filter, a later page, or simply older than the newest
  // twenty-five. Everywhere else on this page the row IS the record, so when
  // there is no row the sheet asks the engine for one — under the very key
  // `RunDetail` reads, so arriving by address costs no second request.
  const addressedId = rowForId ? null : selectedId;
  const addressed = useQuery({
    queryKey: ["run", addressedId ?? ""],
    enabled: allowed && addressedId !== null,
    queryFn: () => apiRequest<Execution>(`/v1/executions/${encodeURIComponent(addressedId ?? "")}`),
  });
  // Never the answer to a question that is no longer being asked: the key
  // changes with the id, and a stale record under the previous one would title
  // the sheet after a run the reader had already closed.
  const selected = rowForId ?? (addressed.data?.id === selectedId ? addressed.data : null);
  useRecordCrumb(selected ? runName(selected, t) : null);

  /**
   * Show one run, or none, and say so in the address.
   *
   * `/runs` and `/runs/$resourceId` render the same component (app/router.tsx),
   * so this moves the history entry without remounting the page: the filters,
   * the page number and the loaded rows are exactly as the reader left them.
   * The query string travels along because it carries the filter the reader
   * arrived with — dropping it would silently widen the list on a reload.
   */
  // A filter the reader removed must also leave the address. `showRun` copies
  // the query string onto every run address, so a cleared narrowing that
  // stayed in the URL came back on the next reload — after the reader had
  // explicitly taken it away.
  const forgetInAddress = useCallback((keys: readonly string[]) => {
    const params = new URLSearchParams(window.location.search);
    for (const key of keys) params.delete(key);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  const showRun = useCallback((id: string | null) => {
    const path = absolute(id ? runHref(id) : runsHref());
    window.history.pushState({}, "", `${path}${window.location.search}`);
    setSelectedId(id);
  }, []);

  // Back and forward are the two buttons every reader already knows for
  // "close that again". Without this the address would change and the sheet
  // would not, which is the same lie as a sheet with no address.
  useEffect(() => {
    const onPopState = () => setSelectedId(runIdFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const columns = useMemo<CockpitColumn<Execution>[]>(() => {
    const column = tableColumns<Execution>({ t, dateTime });
    // `/v1/executions` accepts no `sort`, and `manualSorting` means a sort
    // click that the engine cannot honour would silently do nothing. So the
    // runs table declares no sortable column at all.
    return [
      column.status("status", (run) => run.status, t("resource.field.status"), {
        width: "w-[13%]",
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
      column.date("started_at", (run) => run.started_at, t("runs.column.started"), {
        width: "w-[19%]",
      }),
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
        { width: "w-[12%]" },
      ),
      column.custom(
        "request_source",
        (run) => run.request_source,
        t("runs.column.source"),
        (run) => <LabelText label={requestSourceLabel(run.request_source, t)} />,
        { width: "w-[15%]" },
      ),
      column.custom(
        "kind",
        (run) => run.source_kind,
        t("resource.field.kind"),
        // A child run says so in a word. The line that stood here — "there is
        // no run detail route" — was true until `/runs/$resourceId` existed
        // and is not any more; a restraint justified by a fact that has since
        // changed justifies nothing. The cell is still a word because this
        // renderer returns a string: making the parent reachable is a change
        // to the cell, not to the route, and it is not this one.
        (run) =>
          `${run.hold_writes ? `${t("runs.preparation")} · ` : ""}${
            run.parent_execution_id
              ? `${t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved")} · ${t("runs.childRun")}`
              : t(SOURCE_KIND_KEYS[run.source_kind] ?? "runs.sourceKind.saved")
          }`,
        { width: "w-[15%]" },
      ),
    ];
  }, [t, dateTime, locale]);

  const hasActiveFilters =
    Boolean(debouncedSearch.trim()) ||
    statusFilter !== "all" ||
    sourceFilter !== "all" ||
    workflowFilter !== null;
  const resetFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
    setSourceFilter("all");
    setWorkflowFilter(null);
    setPage(0);
    forgetInAddress(["workflow_id", "status", "source", "q"]);
  }, [forgetInAddress]);

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-runs">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  return (
    <PageFrame surface="collection" testId="resource-runs" title={title} scroll="content">
      <DataTable
        columns={columns}
        data={rows}
        toolbar={
          <>
            <InputGroup className="w-full sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  // A new question is asked from the first page: the answer to
                  // it has its own length, and page three of the old one is
                  // usually empty in the new one.
                  setPage(0);
                }}
                placeholder={t("runs.search")}
                aria-label={t("runs.search")}
                data-testid="runs-search"
              />
            </InputGroup>
            <Select
              value={statusFilter}
              onValueChange={(status) => {
                setStatusFilter(status);
                setPage(0);
              }}
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("catalog.filterStatus")}
                data-testid="runs-status-filter"
              >
                <SelectValue placeholder={t("catalog.allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all" data-testid="runs-status-all">
                    {t("catalog.allStatuses")}
                  </SelectItem>
                  {RUN_STATUSES.map((status) => (
                    <SelectItem key={status} value={status} data-testid={`runs-status-${status}`}>
                      {statusLabel(t, status)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* A link may arrive here already narrowed to one source. Without
                a control saying so, the reader sees a short list and no reason
                for it — the filter would be invisible state, which is the
                defect this page keeps being fixed for. */}
            <Select
              value={sourceFilter}
              onValueChange={(source) => {
                setSourceFilter(source);
                setPage(0);
              }}
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("runs.filterSource")}
                data-testid="runs-source-filter"
              >
                <SelectValue placeholder={t("runs.allSources")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all" data-testid="runs-source-all">
                    {t("runs.allSources")}
                  </SelectItem>
                  {REQUEST_SOURCES.map((source) => (
                    <SelectItem key={source} value={source} data-testid={`runs-source-${source}`}>
                      <LabelText label={requestSourceLabel(source, t)} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* The narrowing a link brought, said out loud and removable. */}
            {workflowFilter ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="runs-workflow-filter"
                onClick={() => {
                  setWorkflowFilter(null);
                  setPage(0);
                  forgetInAddress(["workflow_id"]);
                }}
              >
                {t("runs.workflowFilter")}
              </Button>
            ) : null}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="runs-clear-filters"
                onClick={resetFilters}
              >
                {t("catalog.clearFilters")}
              </Button>
            )}
          </>
        }
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
        refreshLabel={t("common.refresh")}
        pending={query.isPending}
        error={
          query.error
            ? {
                title: t("resource.loadFailed", { resource: title }),
                description: t("resource.loadFailedDescription"),
                retryLabel: t("session.retry"),
                onRetry: () => void query.refetch(),
              }
            : null
        }
        emptyState={{
          zero: {
            title: t("resource.runs.empty"),
            // Never used: a run comes from a workflow, so the next step is one.
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to={workflowsHref()} data-testid="runs-empty-action">
                  {t("runs.empty.action")}
                </Link>
              </Button>
            ),
          },
          filtered: {
            title: t("resource.noMatches"),
            description: t("resource.broaderSearch"),
            resetLabel: t("catalog.clearFilters"),
            onReset: resetFilters,
          },
        }}
        hasActiveFilters={hasActiveFilters}
        sorting={[] as SortingState}
        onSortingChange={() => {}}
        onOpen={(run) => showRun(run.id)}
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        previousLabel={t("catalog.previous")}
        nextLabel={t("catalog.next")}
        columnsLabel={t("catalog.columns")}
        recordsLabel={t("catalog.records")}
        loadedLabel={t("catalog.loaded", { count: rows.length })}
        actionsLabel={t("common.actions")}
        openLabel={t("common.open")}
      />

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => !open && showRun(null)}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          closeLabel={t("common.close")}
          closeTestId="run-detail-close"
          data-testid="run-detail"
          aria-describedby={undefined}
        >
          <SheetHeader>
            <SheetTitle data-testid="run-detail-title">
              {selected ? runName(selected, t) : title}
            </SheetTitle>
          </SheetHeader>
          {/* Three different facts, told apart. The record is here; it is on
              its way; or this address names no run this installation has. A
              blank sheet reads as a rendering fault and an empty fact list
              reads as a run that recorded nothing — neither is what happened. */}
          {selected ? (
            <RunDetail run={selected} />
          ) : addressed.error ? (
            <Alert variant="destructive" className="m-4 w-auto" data-testid="run-detail-missing">
              <AlertTitle>{t("runs.detail.loadFailed")}</AlertTitle>
              <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-3 p-4" data-testid="run-detail-pending">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </PageFrame>
  );
}
