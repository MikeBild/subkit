import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useActorDirectory } from "@/app/actor-directory";
import { absolute, RUNS_FILTER_PARAMS, runHref, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionButton,
  ActionMenu,
  type CockpitColumn,
  CodeBlock,
  CollapsibleSection,
  DataState,
  DataTable,
  type Fact,
  FactList,
  FilterBar,
  RecordSheet,
  RowsSkeleton,
  Section,
  StatusBadge,
  StatusStrip,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { MISSING, type Relation, tableColumns } from "@/components/cockpit/table-columns";
import { causeClassLabel } from "@/lib/cause-class";
import { type ConnectorAuthInput, connectorAuthState } from "@/lib/connector-auth-state";
import { pluralKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { remedyFor } from "@/lib/remedy";
import { refusedSignIn } from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { type CursorPage, listPagePath, useInfiniteList } from "@/lib/use-infinite-list";
import { windowFilterLabel } from "@/lib/window-filter";
import {
  failedStatusesFor,
  filterFromUrl,
  formatRunDuration,
  isExecutionRecord,
  type OutcomeSentence,
  payloadEvidence,
  previewText,
  REQUEST_SOURCES,
  RUN_STATUSES,
  RUNS_FILTER_KEYS,
  type RunFact,
  requestSourceLabel,
  rerunFailureText,
  runCaller,
  runCauseLinks,
  runCostFacts,
  runDurationMs,
  runName,
  runOutcomeSentence,
  runOverlayFromUrl,
  runStatusSentence,
  runsFilterSearch,
  runsSummaryText,
  runVerdict,
  SOURCE_KIND_KEYS,
  stepConnectorId,
  stepGuidance,
  stoppingStep,
} from "@/pages/runs-model";

export { formatRunDuration, RUN_STATUSES, requestSourceLabel, runDurationMs, runName };

type Execution = components["schemas"]["Execution"];
type ExecutionDetail = components["schemas"]["ExecutionDetail"];
type ExecutionListItem = components["schemas"]["ExecutionListItem"];
type ExecutionStep = components["schemas"]["ExecutionStep"];
type ExecutionStepList = components["schemas"]["ExecutionStepListResponse"];

const PAGE_SIZE = 25;

function Copyable({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0" data-action-scope="copy">
      {children}
    </div>
  );
}

function OutcomeText({ sentence }: { sentence: OutcomeSentence }) {
  return (
    <>
      {sentence.lead}
      {sentence.cause ? <LabelText label={sentence.cause} /> : null}
      {sentence.tail}
    </>
  );
}

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
    onError: (error) => toast.error(rerunFailureText(error instanceof ApiError ? error : null, t)),
  });
  const running = isLive(run.status);
  return (
    <ActionButton
      variant="primary"
      disabled={running}
      disabledReason={t("runs.rerun.whileRunning")}
      pending={rerun.isPending}
      onClick={() => rerun.mutate()}
      testId="run-rerun-open"
    >
      {t("runs.rerun.open")}
    </ActionButton>
  );
}

function isLive(status: string): boolean {
  return status === "running" || status === "queued";
}

function RunDetail({ run }: { run: Execution; onShowRun(id: string): void }) {
  const { t, dateTime, locale } = useI18n();
  const session = useSession();
  const directory = useActorDirectory(true);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const detail = useQuery({
    queryKey: ["run", run.id],
    queryFn: () => apiRequest<ExecutionDetail>(`/v1/executions/${encodeURIComponent(run.id)}`),
  });
  const steps = useQuery({
    queryKey: ["run-steps", run.id],
    queryFn: () =>
      apiRequest<ExecutionStepList>(`/v1/executions/${encodeURIComponent(run.id)}/steps`),
  });
  const cost = useQuery({
    queryKey: ["run-cost", run.id],
    queryFn: () => apiRequest<unknown>(`/v1/executions/${encodeURIComponent(run.id)}/cost`),
  });
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
  const sentence = outcome
    ? runOutcomeSentence(outcome, t)
    : failed
      ? runStatusSentence(statusWord(current.status), t)
      : null;

  const canReadWorkflows = session.permissions.includes("workflow:read");
  const patch = useQuery({
    queryKey: ["run-open-repair", current.workflow_id],
    enabled: failed && canReadWorkflows && Boolean(current.workflow_id),
    queryFn: () =>
      apiRequest<{ items: { id: string }[] }>(
        `/v1/patch-candidates?status=proposed&workflow_id=${encodeURIComponent(current.workflow_id ?? "")}&limit=1`,
      ),
  });
  const connectorId = outcome?.cause_class === "auth_failed" ? stepConnectorId(failing) : null;
  const connector = useQuery({
    queryKey: ["connector", connectorId ?? ""],
    enabled: connectorId !== null && session.permissions.includes("connector:read"),
    queryFn: () =>
      apiRequest<ConnectorAuthInput>(`/v1/connectors/${encodeURIComponent(connectorId ?? "")}`),
  });
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
  const duration =
    runDurationMs(current) === null ? null : formatRunDuration(locale, runDurationMs(current) ?? 0);

  const facts: Fact[] = (
    [
      [t("runs.column.started"), current.started_at ? dateTime(current.started_at) : MISSING],
      [t("runs.detail.finished"), current.finished_at ? dateTime(current.finished_at) : MISSING],
      [t("runs.column.duration"), duration ?? MISSING],
      [
        t("resource.field.kind"),
        t(SOURCE_KIND_KEYS[current.source_kind] ?? "runs.sourceKind.saved"),
      ],
      ...runCostFacts(cost.data, t, locale),
    ] as RunFact[]
  ).map(([label, value, full]) => ({
    label,
    value: full ? <span title={full}>{value}</span> : value,
  }));
  const caller = runCaller(current, directory, t);
  const step = openStep === null ? null : (stepItems[openStep] ?? null);
  const stepColumns: CockpitColumn<ExecutionStep>[] = useMemo(() => {
    const column = tableColumns<ExecutionStep>({ t, dateTime });
    return [
      column.custom(
        "step",
        (item) => item.step_key,
        t("workflowSteps.column.step"),
        (item, index) => (
          <span className="font-mono text-xs" data-testid={`run-detail-step-${index}`}>
            {index + 1} {item.step_key}
          </span>
        ),
        { width: "w-[45%]" },
      ),
      column.custom(
        "status",
        (item) => item.status,
        t("resource.field.status"),
        (item) => <StatusBadge state={item.status} />,
        { width: "w-[30%]" },
      ),
      column.custom(
        "duration",
        (item) => item.duration_ms,
        t("runs.column.duration"),
        (item) =>
          item.duration_ms === null ? MISSING : formatRunDuration(locale, item.duration_ms),
        { width: "w-[25%]" },
      ),
    ];
  }, [t, dateTime, locale]);

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="run-detail-body">
      {failed && sentence ? (
        <div data-testid="run-detail-cause">
          <StatusStrip
            tone={verdict.tone === "critical" ? "error" : "warn"}
            line={
              <>
                <span className="font-medium">{verdict.label}</span>
                {" · "}
                <span data-testid="run-detail-outcome">
                  <OutcomeText sentence={sentence} />
                </span>
                <RefusalReasonLine
                  reason={outcome?.refusal_reason}
                  testId="run-detail-refusal-reason"
                  className="block text-xs text-muted-foreground"
                />
              </>
            }
            help={stepGuidance(failing) ?? undefined}
            action={
              remedy
                ? {
                    label: t(remedy.labelKey),
                    href: absolute(remedy.href),
                    testId: "run-detail-cause-remedy",
                  }
                : undefined
            }
          />
        </div>
      ) : isLive(current.status) ? (
        <StatusStrip
          tone="info"
          testId="run-detail-progress"
          line={
            <>
              <span className="font-medium">{verdict.label}</span>
              {" · "}
              {t("runs.strip.running", { step: String(Math.max(1, stepItems.length)) })}
            </>
          }
        />
      ) : (
        <StatusStrip
          tone="ok"
          testId="run-detail-done"
          line={
            <>
              <span className="font-medium">{verdict.label}</span>
              {" · "}
              <span data-testid="run-detail-outcome">
                {sentence && outcome?.output_contract === "violated" ? (
                  <OutcomeText sentence={sentence} />
                ) : (
                  t(pluralKey("runs.strip.done", stepItems.length), {
                    count: stepItems.length,
                    duration: duration ?? MISSING,
                  })
                )}
              </span>
            </>
          }
        />
      )}
      <SummaryLine
        text={[current.started_at ? dateTime(current.started_at) : null, duration]
          .filter(Boolean)
          .join(" · ")}
        testId="run-detail-summary"
      />
      <FactList
        testId="run-detail-caller"
        items={[
          {
            label: t("runs.caller.label"),
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>{[caller.who, caller.channel].filter(Boolean).join(" · ")}</span>
                <StatusBadge
                  state={caller.state}
                  label={t(
                    caller.state === "verified" ? "runs.caller.verified" : "runs.caller.automatic",
                  )}
                />
              </span>
            ),
          },
        ]}
      />
      {detail.error || steps.error ? (
        <DataState
          state="error"
          line={t("runs.detail.loadFailed")}
          onRetry={() => {
            void detail.refetch();
            void steps.refetch();
          }}
          testId="run-detail-error-state"
        />
      ) : steps.isPending ? (
        <RowsSkeleton count={2} testId="run-detail-loading" />
      ) : (
        <>
          {errorEvidence && failing ? (
            <Copyable>
              <CodeBlock
                label={t("runs.detail.errorOfStep", { step: failing.step_key })}
                code={hideTechnicalIdentifiers(errorEvidence, t("tool.referenceHiddenInline"))}
                testId="run-detail-error"
              />
            </Copyable>
          ) : null}
          <Section label={t("runs.detail.steps")} testId="run-detail-steps">
            <RecordTable
              columns={stepColumns}
              data={stepItems}
              collectionId="run-detail-step-list"
              emptyLine={t("runs.detail.noSteps")}
              onOpen={(item) => setOpenStep(stepItems.indexOf(item))}
            />
            {step && openStep !== null ? (
              <RunStepSheet step={step} index={openStep} onClose={() => setOpenStep(null)} />
            ) : null}
          </Section>
          <div className="flex flex-col gap-2">
            {payload ? (
              <CollapsibleSection label={payloadLabel} testId="run-detail-payload">
                <Copyable>
                  <CodeBlock
                    code={hideTechnicalIdentifiers(payload.text, t("tool.referenceHiddenInline"))}
                    testId="run-detail-result"
                  />
                </Copyable>
              </CollapsibleSection>
            ) : null}
            <CollapsibleSection label={t("runs.caller.why")} testId="run-detail-why">
              <FactList
                items={caller.why.map(([label, value, full]) => ({
                  label,
                  value: full ? <span title={full}>{value}</span> : value,
                }))}
                testId="run-detail-why-facts"
              />
            </CollapsibleSection>
            <CollapsibleSection
              label={t("connectorDetail.technical.title")}
              testId="run-detail-technical"
            >
              <FactList items={facts} testId="run-detail-facts" />
            </CollapsibleSection>
          </div>
        </>
      )}
    </div>
  );
}

function RunStepSheet({
  step,
  index,
  onClose,
}: {
  step: ExecutionStep;
  index: number;
  onClose(): void;
}) {
  const { t, locale } = useI18n();
  const evidence = [
    { key: "error", label: t("runs.step.error"), text: previewText(step.error) },
    {
      key: "output",
      label: t("runs.step.output"),
      text: previewText(step.output_preview ?? step.result_preview),
    },
  ].flatMap((entry) => (entry.text === null ? [] : [{ ...entry, text: entry.text }]));
  return (
    <RecordSheet
      open
      onOpenChange={(next) => !next && onClose()}
      size="wide"
      title={
        <span className="font-mono">
          {index + 1} {step.step_key}
        </span>
      }
      badge={<StatusBadge state={step.status} />}
      testId="run-step-sheet"
      closeTestId="run-step-close"
    >
      <FactList
        items={[
          {
            label: t("runs.column.duration"),
            value:
              step.duration_ms === null ? MISSING : formatRunDuration(locale, step.duration_ms),
          },
        ]}
      />
      {evidence.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="run-step-nothing">
          {t("runs.step.nothingRecorded")}
        </p>
      ) : (
        evidence.map(({ key, label, text }) => (
          <Copyable key={key}>
            <CodeBlock
              label={label}
              code={hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
              testId={`run-step-${key}`}
            />
          </Copyable>
        ))
      )}
    </RecordSheet>
  );
}

function RunsList({ onShowRun }: { onShowRun(id: string): void }) {
  const { t, tn, dateTime, locale } = useI18n();
  const [initial] = useState(() => filterFromUrl(window.location.search));
  const [statusFilter, setStatusFilter] = useState<string>(initial.status);
  const [sourceFilter, setSourceFilter] = useState<string>(initial.source);
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
      apiRequest<CursorPage<unknown>>(
        listPagePath("/v1/executions", { ...narrowing, status: failedStatuses }, 1, null),
        { signal },
      ),
  });
  const failedCount = failedStatuses === null ? 0 : (failedTotal.data?.total ?? null);
  const rows = useMemo(
    () => list.items.filter(isExecutionRecord) as ExecutionListItem[],
    [list.items],
  );

  useEffect(() => {
    const search = runsFilterSearch(window.location.search, {
      status: statusFilter,
      source: sourceFilter,
      q: debouncedSearch,
    });
    if (search === window.location.search) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, [statusFilter, sourceFilter, debouncedSearch]);

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
        (run) => run.status,
        t("resource.field.status"),
        (run) => <StatusBadge state={run.status} />,
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

  return (
    <div className="flex flex-col gap-6">
      {list.query.data ? (
        <SummaryLine
          text={runsSummaryText(list.total ?? rows.length, failedCount, tn)}
          testId="runs-summary"
        />
      ) : null}
      <div className="flex h-[calc(100svh-14rem)] min-h-80 flex-col">
        <DataTable
          columns={columns}
          data={rows}
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
                    { value: "all", label: t("runs.allSources") },
                    ...REQUEST_SOURCES.map((source) => ({
                      value: source,
                      label: requestSourceLabel(source, t).text,
                    })),
                  ],
                },
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

function useRun(id: string | null, enabled: boolean) {
  const addressed = useQuery({
    queryKey: ["run", id ?? ""],
    enabled: enabled && id !== null,
    queryFn: () => apiRequest<Execution>(`/v1/executions/${encodeURIComponent(id ?? "")}`),
  });
  const run = isExecutionRecord(addressed.data) && addressed.data.id === id ? addressed.data : null;
  return { run, failed: Boolean(addressed.error), retry: () => void addressed.refetch() };
}

export function RunOverlays() {
  const { t } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("execution:read");
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const overlay = useMemo(() => runOverlayFromUrl(searchStr), [searchStr]);
  const { show } = useOpenRunSheet();
  const { run, failed, retry } = useRun(overlay.runId, allowed);
  if (!allowed) return null;
  const open = overlay.list || overlay.runId !== null;
  const canRerun =
    run !== null &&
    session.permissions.includes("workflow:run") &&
    run.source_kind === "saved" &&
    Boolean(run.workflow_id) &&
    Boolean(run.workflow_version_id);
  const auditLinks = run ? runCauseLinks(run.id, session.permissions, t) : [];
  const title = !overlay.runId
    ? t("runs.all")
    : run
      ? t("runs.sheetTitle", { name: runName(run, t) })
      : t("resource.runs.title");
  return (
    <RecordSheet
      open={open}
      onOpenChange={(next) => !next && show({ list: false, runId: null })}
      size="wide"
      title={
        overlay.runId && run?.workflow_id ? (
          <a
            href={absolute(workflowHref(run.workflow_id))}
            className="min-w-0 underline-offset-4 hover:underline"
            data-testid="run-detail-workflow-link"
          >
            {title}
          </a>
        ) : (
          title
        )
      }
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
      action={
        overlay.runId && run && canRerun ? (
          <RerunAction run={run} onStarted={(id) => show({ list: overlay.list, runId: id })} />
        ) : undefined
      }
      menu={
        overlay.runId && auditLinks.length > 0 ? (
          <ActionMenu
            items={auditLinks.map((link) => ({
              label: link.label,
              href: absolute(link.href),
              testId: "run-detail-audit",
            }))}
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
      {overlay.list ? (
        <div hidden={overlay.runId !== null}>
          <RunsList onShowRun={(id) => show({ list: true, runId: id })} />
        </div>
      ) : null}
      {overlay.runId === null ? null : run ? (
        <RunDetail run={run} onShowRun={(id) => show({ list: overlay.list, runId: id })} />
      ) : failed ? (
        <DataState
          state="error"
          line={t("runs.detail.loadFailed")}
          onRetry={retry}
          testId="run-detail-missing"
        />
      ) : (
        <DataState state="loading" testId="run-detail-pending" />
      )}
    </RecordSheet>
  );
}
