import { useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  filterFromUrl,
  formatRunDuration,
  REQUEST_SOURCES,
  RUN_STATUSES,
  requestSourceLabel,
  runAuthorityFacts,
  runDurationMs,
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

function previewText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text?.trim() ? text : null;
}

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
  const current = detail.data ?? run;
  const stepItems: ExecutionStep[] = steps.data?.items ?? [];
  const failedStep = stepItems.find((step) => previewText(step.error) !== null);
  const errorEvidence = failedStep ? previewText(failedStep.error) : null;
  const resultStep = [...stepItems]
    .reverse()
    .find((step) => previewText(step.output_preview ?? step.result_preview) !== null);
  const resultEvidence = resultStep
    ? previewText(resultStep.output_preview ?? resultStep.result_preview)
    : null;
  const facts: Array<[string, string]> = [
    [t("resource.field.status"), statusLabel(t, current.status)],
    [t("runs.column.started"), current.started_at ? dateTime(current.started_at) : MISSING],
    [t("runs.detail.finished"), current.finished_at ? dateTime(current.finished_at) : MISSING],
    [
      t("runs.column.duration"),
      runDurationMs(current) === null
        ? MISSING
        : formatRunDuration(locale, runDurationMs(current) ?? 0),
    ],
    [t("runs.column.source"), requestSourceLabel(current.request_source, t)],
    [t("resource.field.kind"), t(SOURCE_KIND_KEYS[current.source_kind] ?? "runs.sourceKind.saved")],
    ...runAuthorityFacts(current, t),
  ];

  return (
    <div className="grid gap-5 p-4">
      <dl className="grid grid-cols-2 gap-3" data-testid="run-detail-facts">
        {facts.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-b pb-2">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="text-sm break-words">{value}</dd>
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
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Execution | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const allowed = session.permissions.includes("execution:read");
  const title = t("resource.runs.title");
  const needle = debouncedSearch.trim();
  const query = useQuery({
    // The needle is part of the key: it is a filter the engine applies, so a
    // changed needle is a different question and gets its own answer.
    queryKey: ["runs", statusFilter, sourceFilter, needle, page],
    enabled: allowed,
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (sourceFilter !== "all") params.set("request_source", sourceFilter);
      // The engine searches the whole log by the workflow's name. The list used
      // to narrow the page it had already fetched, which reads as search and is
      // not: a run outside the newest fifty could not be found by name at all.
      if (needle) params.set("q", needle);
      return apiRequest<ExecutionList>(`/v1/executions?${params}`);
    },
  });
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? rows.length;

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
          href: run.workflow_id
            ? `/cockpit/workflows/${encodeURIComponent(run.workflow_id)}`
            : null,
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
        (run) => requestSourceLabel(run.request_source, t),
        { width: "w-[15%]" },
      ),
      column.custom(
        "kind",
        (run) => run.source_kind,
        t("resource.field.kind"),
        // A child run says so in a word. There is no run detail route, so it
        // does not pretend to link to the parent.
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
    Boolean(debouncedSearch.trim()) || statusFilter !== "all" || sourceFilter !== "all";
  const resetFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
    setSourceFilter("all");
    setPage(0);
  }, []);

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
    <PageFrame
      surface="collection"
      testId="resource-runs"
      title={title}
      description={t("resource.runs.description")}
      scroll="content"
    >
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
                      {requestSourceLabel(source, t)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
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
            description: t("resource.emptyDescription"),
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
        onOpen={(run) => setSelected(run)}
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

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className="w-full overflow-y-auto sm:max-w-xl"
          closeLabel={t("common.close")}
          closeTestId="run-detail-close"
          data-testid="run-detail"
        >
          <SheetHeader>
            <SheetTitle data-testid="run-detail-title">
              {selected ? runName(selected, t) : title}
            </SheetTitle>
            <SheetDescription>{t("runs.detail.description")}</SheetDescription>
          </SheetHeader>
          {selected && <RunDetail run={selected} />}
        </SheetContent>
      </Sheet>
    </PageFrame>
  );
}
