import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { ChevronRight, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, runHref, workflowHref, workflowsHref } from "@/app/links";
import { useSession } from "@/app/session";
import { CauseFix } from "@/components/cockpit/cause-fix";
import { ConfirmAction } from "@/components/cockpit/confirm-action";
import { DataState, RecordSheet, StatusBadge } from "@/components/cockpit/patterns";
import { type CockpitColumn, DataTable } from "@/components/cockpit/patterns/data-table";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { causeClassLabel } from "@/lib/cause-class";
import { type ConnectorAuthInput, connectorAuthState } from "@/lib/connector-auth-state";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { remedyFor } from "@/lib/remedy";
import { refusedSignIn } from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { windowFilterLabel } from "@/lib/window-filter";
import {
  executionsQuery,
  filterFromUrl,
  formatRunDuration,
  isExecutionRecord,
  type OutcomeSentence,
  payloadEvidence,
  previewText,
  REQUEST_SOURCES,
  RUN_STATUSES,
  type RunFact,
  requestSourceLabel,
  rerunFailureText,
  runAuthorityFacts,
  runCauseLinks,
  runCostFacts,
  runDurationMs,
  runName,
  runOutcomeSentence,
  runOverlayFromUrl,
  runOverlaySearch,
  runStatusSentence,
  runVerdict,
  SOURCE_KIND_KEYS,
  stepConnectorId,
  stepGuidance,
  stoppingStep,
} from "@/pages/runs-model";

// Re-exported so callers that already know these names keep working; the
// definitions live in the pure model module beside its test.
export { formatRunDuration, RUN_STATUSES, requestSourceLabel, runDurationMs, runName };

type Execution = components["schemas"]["Execution"];
type ExecutionDetail = components["schemas"]["ExecutionDetail"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];
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
        className={`rounded-lg border p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap ${
          tone === "error" ? "border-destructive/40 bg-destructive/5" : "bg-muted/40"
        }`}
        data-testid={testId}
      >
        {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
      </pre>
    </section>
  );
}

/**
 * The words of an outcome, with an unmapped cause set as a machine value.
 */
function OutcomeText({ sentence }: { sentence: OutcomeSentence }) {
  return (
    <>
      {sentence.lead}
      {sentence.cause ? <LabelText label={sentence.cause} /> : null}
      {sentence.tail}
    </>
  );
}

/**
 * Run the same thing again — same version, same input, real effects.
 *
 * Offered only where the engine accepts it: a saved workflow's run that still
 * names its version. The dialog states the consequence before anything runs,
 * and the new run opens in this sheet once it exists.
 */
function RerunAction({ run, onStarted }: { run: Execution; onStarted(id: string): void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const rerun = useMutation({
    mutationFn: () =>
      apiRequest<{ execution_id: string }>(`/v1/executions/${encodeURIComponent(run.id)}/rerun`, {
        method: "POST",
        body: JSON.stringify({ async: true }),
      }),
    onSuccess: async (result) => {
      toast.success(t("runs.rerun.started"));
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      onStarted(result.execution_id);
    },
  });
  return (
    <ConfirmAction
      triggerLabel={
        <>
          <RotateCcw data-icon="inline-start" />
          {t("runs.rerun.open")}
        </>
      }
      title={t("runs.rerun.title")}
      consequence={t("runs.rerun.consequence", { workflow: runName(run, t) })}
      confirmLabel={t("runs.rerun.confirm")}
      onConfirm={() => rerun.mutateAsync()}
      error={
        rerun.error
          ? rerunFailureText(rerun.error instanceof ApiError ? rerun.error : null, t)
          : null
      }
      testId="run-rerun"
    />
  );
}

function RunDetail({ run, onShowRun }: { run: Execution; onShowRun(id: string): void }) {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const detail = useQuery({
    queryKey: ["run", run.id],
    queryFn: () => apiRequest<ExecutionDetail>(`/v1/executions/${encodeURIComponent(run.id)}`),
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
  const current: Execution = isExecutionRecord(detail.data) ? detail.data : run;
  const outcome =
    isExecutionRecord(detail.data) && (detail.data as ExecutionDetail).outcome
      ? (detail.data as ExecutionDetail).outcome
      : null;
  const stepItems: ExecutionStep[] = steps.data?.items ?? [];
  const failing = stoppingStep(stepItems, outcome);
  const errorEvidence = failing ? previewText(failing.error) : null;
  const payload = payloadEvidence(stepItems, current.status, outcome);
  const statusWord = (status: string) => statusLabel(t, status);
  const verdict = runVerdict(current.status, outcome, t, statusWord);
  const failed = verdict.tone !== null;
  // Without the engine's outcome a failed run still gets its block: what is
  // known is how it ended, and the way to the fix does not depend on more.
  const sentence = outcome
    ? runOutcomeSentence(outcome, t)
    : failed
      ? runStatusSentence(statusWord(current.status), t)
      : null;

  const canReadWorkflows = session.permissions.includes("workflow:read");
  // An open repair proposal for this workflow is the first remedy: the engine
  // already has a fix waiting, and a chat about it would rediscover it.
  const patch = useQuery({
    queryKey: ["run-open-repair", current.workflow_id],
    enabled: failed && canReadWorkflows && Boolean(current.workflow_id),
    queryFn: () =>
      apiRequest<{ items: { id: string }[] }>(
        `/v1/patch-candidates?status=proposed&workflow_id=${encodeURIComponent(current.workflow_id ?? "")}&limit=1`,
      ),
  });
  const connectorId = outcome?.cause_class === "auth_failed" ? stepConnectorId(failing) : null;
  // Where the connector's sign-in really stands — read from the connector,
  // not assumed from the run: a rejected request may be a missing scope.
  const connector = useQuery({
    queryKey: ["connector", connectorId ?? ""],
    enabled: connectorId !== null && session.permissions.includes("connector:read"),
    queryFn: () =>
      apiRequest<ConnectorAuthInput>(`/v1/connectors/${encodeURIComponent(connectorId ?? "")}`),
  });
  // A run refused for its connector ran no step to read a connector from:
  // the refusal itself names the connector and why, as resolved in the run's
  // environment.
  const authState = connectorId
    ? {
        connectorId,
        state:
          connector.data && typeof connector.data === "object"
            ? connectorAuthState(connector.data)
            : "unproven",
      }
    : outcome?.cause_class === "connector_unavailable"
      ? refusedSignIn(outcome.connector)
      : null;
  const remedy = failed
    ? remedyFor({
        workflowId: current.workflow_id,
        executionId: current.id,
        patch: patch.data?.items?.[0] ?? null,
        authState,
        held: outcome?.cause_class === "authority_mismatch",
        canRun: session.permissions.includes("workflow:run"),
        canChat: session.permissions.includes("conversation:write"),
        prompt: t("remedy.chatPrompt"),
      })
    : null;
  const payloadLabel = payload?.preview
    ? t("runs.detail.preview")
    : payload?.stepKey
      ? t("runs.detail.outputOfStep", { step: payload.stepKey })
      : t("tool.result");
  // Offered for a partly failed run as well as a failed one: the dialog says
  // the rerun repeats every step with real effects, including the ones that
  // already ran — the reader decides with that sentence in front of them.
  const canRerun =
    session.permissions.includes("workflow:run") &&
    current.source_kind === "saved" &&
    Boolean(current.workflow_id) &&
    Boolean(current.workflow_version_id);

  const facts: RunFact[] = [
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
    // One column that may shrink below its content: without it, a long
    // unbroken token (a resolved URL in an error) sizes the track and the
    // sheet clips everything at its edge.
    <div className="grid grid-cols-1 gap-5 p-4">
      <dl className="grid grid-cols-2 gap-3" data-testid="run-detail-facts">
        {facts.map(([label, value, full]) => (
          // `min-w-0`, or one long label or value sets this column's minimum
          // width and the sheet clips it on a phone.
          <div key={label} className="grid min-w-0 grid-cols-1 gap-1 border-b pb-2 break-words">
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

      {/* What happened, in one sentence — and for a failure, why and what to
          do about it, in the same block. */}
      {sentence && failed ? (
        <CauseFix
          testId="run-detail-cause"
          status={{ tone: verdict.tone ?? "critical", label: verdict.label }}
          cause={
            <>
              <span data-testid="run-detail-outcome">
                <OutcomeText sentence={sentence} />
              </span>
              {/* Which rule the approval refused the step for — the cause
                  class says only THAT it no longer fits. */}
              <RefusalReasonLine
                reason={outcome?.refusal_reason}
                testId="run-detail-refusal-reason"
                className="mt-1 block"
              />
            </>
          }
          guidance={stepGuidance(failing)}
          remedy={remedy ? { label: t(remedy.labelKey), href: remedy.href } : null}
          more={runCauseLinks(current.id, session.permissions, t)}
          actions={
            canRerun ? <RerunAction run={current} onStarted={(id) => onShowRun(id)} /> : null
          }
        />
      ) : sentence ? (
        <p className="text-sm" data-testid="run-detail-outcome">
          <OutcomeText sentence={sentence} />
        </p>
      ) : null}

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
          {/* The run's error, ONCE. It used to stand here and again inside the
              step card below, so the reader read the same stack twice and
              wondered whether two things had gone wrong. */}
          {errorEvidence && failing && (
            <EvidenceBlock
              title={t("runs.detail.errorOfStep", { step: failing.step_key })}
              text={errorEvidence}
              tone="error"
              testId="run-detail-error"
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
                // The stopping step's error is the block above; any other
                // step's error (one that continued) is its own and stays here.
                const stepError = step === failing ? null : previewText(step.error);
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
                      <pre className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
                        {hideTechnicalIdentifiers(stepError, t("tool.referenceHiddenInline"))}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </section>
          {/* The payload last, closed: it is the evidence, not the headline.
              A failed run's newest output belongs to a step, and says which. */}
          {payload && (
            <Collapsible data-testid="run-detail-payload">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 w-fit"
                  data-testid="run-detail-payload-toggle"
                >
                  <ChevronRight data-icon="inline-start" />
                  {payloadLabel}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <EvidenceBlock
                  title={payloadLabel}
                  text={payload.text}
                  tone="result"
                  testId="run-detail-result"
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
    </div>
  );
}

/**
 * All runs, narrowed (O3): the list inside the large sheet. It reads its
 * narrowing from the address once, when the sheet opens, and writes back what
 * the reader removes.
 */
function RunsList({ onShowRun }: { onShowRun(id: string): void }) {
  const { t, dateTime, locale } = useI18n();
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
  // The window a usage figure counted over. Like the workflow, it arrives with
  // a link and is lifted by its chip.
  const [startedWindow, setStartedWindow] = useState<{ from: string | null; to: string | null }>({
    from: initial.startedFrom,
    to: initial.startedTo,
  });
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(search);
  const title = t("resource.runs.title");
  const needle = debouncedSearch.trim();
  const query = useQuery({
    // The needle is part of the key: it is a filter the engine applies, so a
    // changed needle is a different question and gets its own answer.
    queryKey: ["runs", statusFilter, sourceFilter, workflowFilter, startedWindow, needle, page],
    queryFn: () => {
      const params = executionsQuery(
        {
          status: statusFilter,
          source: sourceFilter,
          workflowId: workflowFilter,
          q: needle,
          startedFrom: startedWindow.from,
          startedTo: startedWindow.to,
        },
        { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      );
      return apiRequest<ExecutionList>(`/v1/executions?${params}`);
    },
  });
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? rows.length;

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

  const columns = useMemo<CockpitColumn<ExecutionListItem>[]>(() => {
    const column = tableColumns<ExecutionListItem>({ t, dateTime });
    // `/v1/executions` accepts no `sort`, and `manualSorting` means a sort
    // click that the engine cannot honour would silently do nothing. So the
    // runs table declares no sortable column at all.
    return [
      column.status("status", (run) => run.status, t("resource.field.status"), {
        width: "w-[12%]",
      }),
      column.link(
        "workflow",
        (run): Relation | null => ({
          href: run.workflow_id ? absolute(workflowHref(run.workflow_id)) : null,
          label: runName(run, t),
        }),
        t("runs.column.workflow"),
        { width: "w-[22%]" },
      ),
      column.date("started_at", (run) => run.started_at, t("runs.column.started"), {
        width: "w-[15%]",
      }),
      // The cause group a failure belongs to (§3), in words. A run that did not
      // fail has no cause, and its cell is EMPTY — a dash there would read as
      // "cause unknown" about a run that has none.
      column.custom(
        "cause",
        (run) => run.failure?.cause_class ?? null,
        t("runs.column.cause"),
        (run) => {
          const cause = run.failure?.cause_class;
          return cause && cause !== "ok" ? (
            <span data-testid="runs-cause">
              <LabelText label={causeClassLabel(cause, t)} />
              <RefusalReasonLine
                reason={run.failure?.refusal_reason}
                testId="runs-refusal-reason"
                className="block text-xs text-muted-foreground"
              />
            </span>
          ) : null;
        },
        { width: "w-[14%]" },
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
        { width: "w-[9%]" },
      ),
      column.custom(
        "request_source",
        (run) => run.request_source,
        t("runs.column.source"),
        (run) => <LabelText label={requestSourceLabel(run.request_source, t)} />,
        { width: "w-[13%]" },
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
    workflowFilter !== null ||
    startedWindow.from !== null ||
    startedWindow.to !== null;
  const resetFilters = useCallback(() => {
    setSearch("");
    setStatusFilter("all");
    setSourceFilter("all");
    setWorkflowFilter(null);
    setStartedWindow({ from: null, to: null });
    setPage(0);
    forgetInAddress(["workflow_id", "status", "source", "q", "started_from", "started_to"]);
  }, [forgetInAddress]);

  return (
    <div className="flex h-[calc(100svh-9rem)] min-h-80 flex-col">
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
            {startedWindow.from || startedWindow.to ? (
              <Button
                variant="secondary"
                size="sm"
                data-testid="runs-window-filter"
                onClick={() => {
                  setStartedWindow({ from: null, to: null });
                  setPage(0);
                  forgetInAddress(["started_from", "started_to"]);
                }}
              >
                {windowFilterLabel(startedWindow.from, startedWindow.to, t, dateTime)}
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
        onOpen={(run) => onShowRun(run.id)}
        rowHref={(run) => runHref(run.id)}
        linkColumn="started_at"
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
      />
    </div>
  );
}

/** One run, fetched by id: the sheet says what the record says NOW. */
function useRun(id: string | null, enabled: boolean) {
  const addressed = useQuery({
    queryKey: ["run", id ?? ""],
    enabled: enabled && id !== null,
    queryFn: () => apiRequest<Execution>(`/v1/executions/${encodeURIComponent(id ?? "")}`),
  });
  // Never the answer to a question that is no longer being asked: the key
  // changes with the id, and a stale record under the previous one would title
  // the sheet after a run the reader had already closed.
  const run = isExecutionRecord(addressed.data) && addressed.data.id === id ? addressed.data : null;
  return { run, failed: Boolean(addressed.error) };
}

/**
 * The run sheets, on whichever view opened them (O2, O3).
 *
 * `?runs=all` opens all runs in the large sheet; `?run=<id>` opens one run —
 * inside the large sheet, with the way back to the list, when the list is
 * open, and in a sheet of its own otherwise. Both live in the query: the page
 * underneath stays what it was, and back and forward close them again.
 */
export function RunOverlays() {
  const { t } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("execution:read");
  const href = useRouterState({ select: (state) => state.location.href });
  const [overlay, setOverlay] = useState(() => runOverlayFromUrl(window.location.search));
  // A router navigation (a link to `?run=…` on the same page) and a history
  // step both change the address under the sheets; the sheets follow it.
  useEffect(() => {
    setOverlay(runOverlayFromUrl(window.location.search));
  }, [href]);
  useEffect(() => {
    const onPopState = () => setOverlay(runOverlayFromUrl(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const show = useCallback((next: { list: boolean; runId: string | null }) => {
    const search = runOverlaySearch(window.location.search, next);
    window.history.pushState({}, "", `${window.location.pathname}${search}${window.location.hash}`);
    setOverlay(next);
  }, []);
  const { run, failed } = useRun(overlay.runId, allowed);
  if (!allowed) return null;
  const open = overlay.list || overlay.runId !== null;
  const title = !overlay.runId ? (
    t("runs.all")
  ) : run?.workflow_id ? (
    // The title is the workflow, and leads there: the run is one answer about
    // it, and the way to change it starts at the workflow.
    <a
      href={absolute(workflowHref(run.workflow_id))}
      className="min-w-0 underline-offset-4 hover:underline"
      data-testid="run-detail-workflow-link"
    >
      {runName(run, t)}
    </a>
  ) : run ? (
    runName(run, t)
  ) : (
    t("resource.runs.title")
  );
  return (
    <RecordSheet
      open={open}
      onOpenChange={(next) => !next && show({ list: false, runId: null })}
      size={overlay.list ? "wide" : "default"}
      title={title}
      titleTestId={overlay.runId ? "run-detail-title" : "runs-sheet-title"}
      badge={
        overlay.runId && run ? (
          <StatusBadge
            state={run.status}
            label={
              runVerdict(run.status, (run as ExecutionDetail).outcome ?? null, t, (status) =>
                statusLabel(t, status),
              ).label
            }
            testId="run-detail-status"
          />
        ) : undefined
      }
      back={
        overlay.list && overlay.runId
          ? { label: t("runs.all"), onClick: () => show({ list: true, runId: null }) }
          : undefined
      }
      testId={overlay.runId ? "run-detail" : "resource-runs"}
      closeTestId={overlay.runId ? "run-detail-close" : "runs-sheet-close"}
    >
      {/* The list stays mounted under an open run, so its filters, its page
          and its rows are exactly as the reader left them on the way back. */}
      {overlay.list ? (
        <div hidden={overlay.runId !== null}>
          <RunsList onShowRun={(id) => show({ list: true, runId: id })} />
        </div>
      ) : null}
      {/* Three different facts, told apart. The record is here; it is on its
          way; or this address names no run this installation has. */}
      {overlay.runId === null ? null : run ? (
        <RunDetail run={run} onShowRun={(id) => show({ list: overlay.list, runId: id })} />
      ) : failed ? (
        <DataState
          state="error"
          line={t("runs.detail.loadFailed")}
          onRetry={() => show({ ...overlay })}
          testId="run-detail-missing"
        />
      ) : (
        <DataState state="loading" testId="run-detail-pending" />
      )}
    </RecordSheet>
  );
}
