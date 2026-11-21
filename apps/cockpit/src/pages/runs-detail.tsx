import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ErrorNotice } from "@ui/components/proto/ErrorNotice";
import { Check, ChevronRight, Minus, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { actorDirectoryName } from "@/app/actor-directory-model";
import { absolute, workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import { technicalFactsPlace } from "@/app/side-panel-model";
import { useNameIndex } from "@/app/use-decisions";
import { connectorService, useConnectorRecords } from "@/components/cockpit/connector-names";
import {
  ActionButton,
  CodeBlock,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  RowsSkeleton,
  Section,
  SideDetails,
  SideOverlayLayer,
  SideSection,
  SideStatus,
  StatusBadge,
  StatusStrip,
  SummaryLine,
  statusTone,
  TechnicalDetails,
  useSheetDocked,
  useSideDetailsAvailable,
} from "@/components/cockpit/patterns";
import { RefusalReasonLine } from "@/components/cockpit/refusal-reason";
import { MISSING } from "@/components/cockpit/table-columns";
import { useCurrentVersionDag } from "@/components/cockpit/workflow-versions";
import {
  RunResultDocument,
  RunStepGraph,
  RunWhy,
  runFailureKind,
  runFailureRows,
  runGraphSteps,
  runResultMarkdown,
} from "@/features/operations";
import { reportFailure } from "@/lib/action-failure";
import { connectorAuthState } from "@/lib/connector-auth-state";
import { pluralKey, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { LabelText } from "@/lib/machine-label";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { remedyFor } from "@/lib/remedy";
import { refusedSignIn } from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import { definitionKind, stepDefinitionsOf, stepKindKey } from "@/lib/workflow-steps";
import {
  formatRunDuration,
  isExecutionRecord,
  type OutcomeSentence,
  payloadEvidence,
  previewText,
  type RunFact,
  rerunFailureText,
  runCaller,
  runCostFacts,
  runDurationMs,
  runOutcomeSentence,
  runPermissionEvidence,
  runStatusSentence,
  runTraceEvidence,
  runTruncationSentence,
  runVerdict,
  SOURCE_KIND_KEYS,
  stepConnectorId,
  stepCredentialSnapshots,
  stepEffectKind,
  stepGuidance,
  stepWasHeld,
  stoppingStep,
  truncatedSteps,
} from "@/pages/runs-model";

type Execution = components["schemas"]["Execution"];
type ExecutionDetail = components["schemas"]["ExecutionDetail"];
type ExecutionStep = components["schemas"]["ExecutionStep"];

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

export function RerunAction({ run, onStarted }: { run: Execution; onStarted(id: string): void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["run", run.id, "rerun-safety"],
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: run.id } }),
  });
  const safety = detail.data?.outcome.rerun_safety;
  const prepareOnly = safety?.mode === "prepare_only";
  const unavailable = !safety || safety.mode === "unavailable";
  const rerun = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/executions/{id}/rerun", {
        path: { id: run.id },
        body: { async: true, ...(prepareOnly ? { hold_writes: true } : {}) },
      }),
    onSuccess: async (result) => {
      toast.success(t("runs.rerun.started"));
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      onStarted(result.execution_id);
    },
    onError: (error) =>
      reportFailure(rerunFailureText(error instanceof ApiError ? error : null, t), error),
  });
  const running = isLive(run.status);
  const disabled = running || unavailable || detail.isPending;
  const disabledReason = running
    ? t("runs.rerun.whileRunning")
    : safety?.reason || t("runs.rerun.unavailable");
  return (
    <ActionButton
      disabled={disabled}
      disabledReason={disabledReason}
      pending={rerun.isPending}
      onClick={() => rerun.mutate()}
      testId="run-rerun-open"
    >
      {t(prepareOnly ? "runs.rerun.prepare" : "runs.rerun.open")}
    </ActionButton>
  );
}

function isLive(status: string): boolean {
  return status === "running" || status === "queued";
}

function Layer({ page, children }: { page: boolean; children: ReactNode }) {
  return page ? children : <SideOverlayLayer>{children}</SideOverlayLayer>;
}

export function RunDetail({ run, page = false }: { run: Execution; page?: boolean }) {
  const { t, dateTime, locale } = useI18n();
  const router = useRouter();
  const session = useSession();
  const directory = useActorDirectory(true);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const docked = useSheetDocked();
  const side =
    technicalFactsPlace({
      sidePanel: useSideDetailsAvailable(),
      presentation: page ? "page" : docked ? "docked" : "modal",
    }) === "details";
  const detail = useQuery({
    queryKey: ["run", run.id],
    queryFn: () => apiCall("get", "/v1/executions/{id}", { path: { id: run.id } }),
  });
  const steps = useQuery({
    queryKey: ["run-steps", run.id],
    queryFn: () => apiCall("get", "/v1/executions/{id}/steps", { path: { id: run.id } }),
  });
  const cost = useQuery({
    queryKey: ["run-cost", run.id],
    queryFn: () => apiCall("get", "/v1/executions/{id}/cost", { path: { id: run.id } }),
  });
  const current: Execution = isExecutionRecord(detail.data) ? detail.data : run;
  const kindOf = useRunStepKind(current);
  const outcome =
    isExecutionRecord(detail.data) && (detail.data as ExecutionDetail).outcome
      ? (detail.data as ExecutionDetail).outcome
      : null;
  const stepItems: ExecutionStep[] = steps.data?.items ?? [];
  const failing = stoppingStep(stepItems, outcome);
  const errorEvidence = failing ? previewText(failing.error) : null;
  const payload = payloadEvidence(stepItems, current.status, outcome);
  const statusWord = (status: string) => statusLabel(t, status);
  const truncated = truncatedSteps(stepItems);
  const verdict = runVerdict(current.status, outcome, t, statusWord, truncated);
  const failed = verdict.tone !== null;
  const held = outcome?.kind === "held";
  const sentence = verdict.truncated
    ? runTruncationSentence(truncated, t)
    : outcome
      ? runOutcomeSentence(outcome, t)
      : failed
        ? runStatusSentence(statusWord(current.status), t)
        : null;

  const canReadWorkflows = session.permissions.includes("workflow:read");
  const executionAuthority = useQuery({
    queryKey: ["run-authority", current.workflow_id, current.execution_authority_id],
    enabled: Boolean(canReadWorkflows && current.workflow_id && current.execution_authority_id),
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/execution-authorities/{authority_id}", {
        path: {
          id: current.workflow_id ?? "",
          authority_id: current.execution_authority_id ?? "",
        },
      }),
  });
  const patch = useQuery({
    queryKey: ["run-open-repair", current.workflow_id],
    enabled: failed && canReadWorkflows && Boolean(current.workflow_id),
    queryFn: () =>
      apiCall("get", "/v1/patch-candidates", {
        query: { status: "proposed", workflow_id: current.workflow_id ?? "", limit: 1 },
      }),
  });
  const connectorId = outcome?.cause_class === "auth_failed" ? stepConnectorId(failing) : null;
  const connector = useQuery({
    queryKey: ["connector", connectorId ?? ""],
    enabled: connectorId !== null && session.permissions.includes("connector:read"),
    queryFn: () => apiCall("get", "/v1/connectors/{id}", { path: { id: connectorId ?? "" } }),
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
  const remedy =
    failed || held
      ? remedyFor({
          workflowId: current.workflow_id,
          executionId: current.id,
          patch: patch.data?.items?.[0] ?? null,
          authState,
          held: held || outcome?.cause_class === "authority_mismatch",
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

  const permissionEvidence = runPermissionEvidence(
    current as Execution & {
      permission_basis?: unknown;
      permission_phase?: unknown;
      permission_checked_at?: unknown;
    },
  );

  const facts: Fact[] = (
    [
      [t("runs.detail.runId"), current.id],
      ...(current.workflow_version_id
        ? [[t("authority.version"), current.workflow_version_id] as RunFact]
        : []),
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
  const trace = runTraceEvidence(current, session.permissions.includes("audit:read"));
  facts.push({
    label: t("audit.detail.trace"),
    value: trace.id ? (
      trace.href ? (
        <a
          href={absolute(trace.href)}
          className="underline underline-offset-4"
          data-testid="run-detail-trace-audit"
        >
          {trace.id}
        </a>
      ) : (
        trace.id
      )
    ) : (
      MISSING
    ),
  });
  const caller = runCaller(current, directory, t);
  const stepNames = useNameIndex(session.permissions, true);
  const step = openStep === null ? null : (stepItems[openStep] ?? null);
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="run-detail-body">
      {side && !page ? (
        <Layer page={page}>
          <SideStatus
            testId="side-run-status"
            tone={
              failed || held
                ? held || verdict.tone !== "critical"
                  ? "warn"
                  : "error"
                : isLive(current.status)
                  ? "info"
                  : "ok"
            }
            line={[verdict.label, sentence?.plain ?? null].filter(Boolean).join(" · ")}
            more={[current.started_at ? dateTime(current.started_at) : null, duration]
              .filter(Boolean)
              .join(" · ")}
          />
        </Layer>
      ) : null}
      {(failed || held) && sentence ? (
        <ErrorNotice
          testId="run-detail-cause"
          kind={runFailureKind(outcome?.cause_class ?? null, current.status)}
          tone={held || verdict.tone !== "critical" ? "warning" : "danger"}
          title={held ? t("workflow.preview.held") : verdict.label}
          body={
            <span className="flex flex-col gap-1">
              <span data-testid="run-detail-outcome">
                <OutcomeText sentence={sentence} />
              </span>
              <RefusalReasonLine
                reason={outcome?.refusal_reason}
                testId="run-detail-refusal-reason"
                className="block text-xs"
              />
              {stepGuidance(failing) ? (
                <span className="text-xs">{stepGuidance(failing)}</span>
              ) : null}
            </span>
          }
          primary={
            remedy
              ? {
                  label: t(remedy.labelKey),
                  onClick: () => router.history.push(absolute(remedy.href)),
                  testId: "run-detail-cause-remedy",
                }
              : undefined
          }
          rows={runFailureRows(
            {
              runId: current.id,
              stepKey: failing?.step_key ?? null,
              cause: outcome?.cause_class ?? null,
              finishedAt: current.finished_at ?? null,
            },
            {
              runId: t("runs.detail.runId"),
              step: t("workflowFlow.sheet.key"),
              code: t("error.code"),
              finished: t("runs.detail.finished"),
            },
            dateTime,
          )}
        />
      ) : isLive(current.status) ? (
        <StatusStrip
          tone="info"
          testId="run-detail-progress"
          line={
            <>
              <span className="font-medium">{verdict.label}</span>
              {" · "}
              {typeof (outcome as { planned_steps?: number | null } | null)?.planned_steps ===
                "number" &&
              Number((outcome as { planned_steps?: number }).planned_steps) >= stepItems.length
                ? t("runs.strip.runningTotal", {
                    step: Math.max(1, stepItems.length),
                    total: Number((outcome as { planned_steps?: number }).planned_steps),
                  })
                : t("runs.strip.running", { step: String(Math.max(1, stepItems.length)) })}
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
                <StatusBadge state={caller.state} label={t(caller.stateLabel)} />
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
          {page ? (
            <RunStepGraph
              steps={runGraphSteps(
                stepItems,
                (outcome as { planned_steps?: number | null } | null)?.planned_steps ?? null,
                current.status === "succeeded",
              )}
              testId="run-detail-graph"
            />
          ) : null}
          <RunResultDocument
            result={runResultMarkdown(detail.data)}
            empty={
              page
                ? t(isLive(current.status) ? "ops.run.resultPending" : "ops.run.resultNone")
                : undefined
            }
            testId="run-detail-result"
          />
          <Section label={t("runs.detail.steps")} testId="run-detail-steps">
            <RunStepChain
              steps={stepItems}
              connectorNames={stepNames.connector}
              kindOf={kindOf}
              onOpen={setOpenStep}
            />
            {step && openStep !== null ? (
              <RunStepSheet
                step={step}
                index={openStep}
                kindOf={kindOf}
                onClose={() => setOpenStep(null)}
              />
            ) : null}
          </Section>
          <div className="flex flex-col gap-6">
            <RunWhy
              testId="run-detail-why"
              rows={caller.why
                .map(([label, value, full]) => ({
                  label,
                  value:
                    label === t("authority.usedByRun") &&
                    current.execution_authority_id &&
                    current.workflow_id &&
                    canReadWorkflows ? (
                      <a
                        href={absolute(`${workflowHref(current.workflow_id)}#workflow-automation`)}
                        title={current.execution_authority_id}
                        data-testid="run-detail-authority-workflow"
                      >
                        {value}
                      </a>
                    ) : full ? (
                      <span title={full}>{value}</span>
                    ) : (
                      value
                    ),
                }))
                .concat([
                  {
                    label: t("runs.permission.label"),
                    value: permissionEvidence
                      ? `${t(`runs.permission.${permissionEvidence.basis}`)} · ${t(`runs.permission.${permissionEvidence.phase}`, { when: dateTime(permissionEvidence.checkedAt) })}`
                      : t("runs.caller.unknown"),
                  },
                  ...(current.execution_authority_id
                    ? [
                        {
                          label: t("runs.permission.authorizedBy"),
                          value:
                            actorDirectoryName(
                              directory,
                              "user",
                              executionAuthority.data?.created_by ?? null,
                            ) ??
                            actorDirectoryName(
                              directory,
                              "system_account",
                              executionAuthority.data?.created_by ?? null,
                            ) ??
                            t("runs.permission.authorizedByUnknown"),
                        },
                      ]
                    : []),
                  ...(executionAuthority.data
                    ? [
                        {
                          label: t("ops.run.approvedAt"),
                          value: dateTime(executionAuthority.data.created_at),
                        },
                      ]
                    : []),
                  {
                    label: t("authority.environment"),
                    value:
                      (current as Execution & { execution_environment?: string })
                        .execution_environment === "prod"
                        ? t("authority.production")
                        : (current as Execution & { execution_environment?: string })
                              .execution_environment === "dev"
                          ? t("authority.development")
                          : MISSING,
                  },
                  ...(executionAuthority.data
                    ? [
                        {
                          label: t("authority.limit.label"),
                          value: executionAuthority.data.valid_until
                            ? t("ops.run.validUntil", {
                                date: dateTime(executionAuthority.data.valid_until),
                              })
                            : t("authority.limit.untilRevoked"),
                        },
                        {
                          label: t("authority.runs"),
                          value:
                            executionAuthority.data.max_runs === null
                              ? t("ops.approval.noLimit")
                              : String(executionAuthority.data.max_runs),
                        },
                      ]
                    : []),
                ])}
            />
            {side ? (
              <Layer page={page}>
                <SideDetails>
                  <SideSection title={t("sidePanel.details.technical")} testId="side-run-technical">
                    <FactList items={facts} testId="run-detail-facts" />
                    {errorEvidence && failing ? (
                      <Copyable>
                        <CodeBlock
                          label={t("runs.detail.errorOfStep", { step: failing.step_key })}
                          code={hideTechnicalIdentifiers(
                            errorEvidence,
                            t("tool.referenceHiddenInline"),
                          )}
                          testId="run-detail-error"
                        />
                      </Copyable>
                    ) : null}
                    {payload ? (
                      <Copyable>
                        <CodeBlock
                          label={payloadLabel}
                          code={hideTechnicalIdentifiers(
                            payload.text,
                            t("tool.referenceHiddenInline"),
                          )}
                          testId="run-detail-result"
                        />
                      </Copyable>
                    ) : null}
                  </SideSection>
                </SideDetails>
              </Layer>
            ) : (
              <TechnicalDetails testId="run-detail-technical">
                <FactList items={facts} testId="run-detail-facts" />
                {errorEvidence && failing ? (
                  <Copyable>
                    <CodeBlock
                      label={t("runs.detail.errorOfStep", { step: failing.step_key })}
                      code={hideTechnicalIdentifiers(
                        errorEvidence,
                        t("tool.referenceHiddenInline"),
                      )}
                      testId="run-detail-error"
                    />
                  </Copyable>
                ) : null}
                {payload ? (
                  <Copyable>
                    <CodeBlock
                      label={payloadLabel}
                      code={hideTechnicalIdentifiers(payload.text, t("tool.referenceHiddenInline"))}
                      testId="run-detail-result"
                    />
                  </Copyable>
                ) : null}
              </TechnicalDetails>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const STEP_MARK: Record<"ok" | "warn" | "error" | "neutral", string> = {
  ok: "bg-success/10 text-success-ink",
  warn: "bg-warning/10 text-warning-ink",
  error: "bg-destructive/10 text-destructive-ink",
  neutral: "bg-muted text-muted-foreground",
};

type StepKindOf = (step: ExecutionStep) => TranslationKey;

function useRunStepKind(run: Pick<Execution, "workflow_id" | "workflow_version_id">): StepKindOf {
  const session = useSession();
  const records = useConnectorRecords();
  const version = useCurrentVersionDag(
    run.workflow_id ?? "",
    run.workflow_version_id,
    null,
    session.permissions.includes("workflow:read"),
  );
  const definitions = useMemo(() => stepDefinitionsOf(version.data), [version.data]);
  return (step) => {
    const id = stepConnectorId(step);
    const record = id ? records.find((item) => item.id === id) : undefined;
    const service = record ? connectorService(record) : null;
    const definition = definitions.get(step.step_key);
    return stepKindKey(
      definition ? definitionKind(definition, service) : { kind: step.kind, service },
    );
  };
}

function RunStepChain({
  steps,
  connectorNames,
  kindOf,
  onOpen,
}: {
  steps: readonly ExecutionStep[];
  connectorNames: ReadonlyMap<string, string>;
  kindOf: StepKindOf;
  onOpen(index: number): void;
}) {
  const { t, locale } = useI18n();
  if (steps.length === 0)
    return <p className="text-sm text-muted-foreground">{t("runs.detail.noSteps")}</p>;
  return (
    <ol
      className="relative flex flex-col before:absolute before:top-3 before:bottom-3 before:left-[9px] before:w-px before:bg-border"
      data-testid="run-detail-step-chain"
    >
      {steps.map((item, index) => {
        const held = stepWasHeld(item);
        const tone = held ? "warn" : statusTone(item.status);
        const connector = stepConnectorId(item);
        const effect = stepEffectKind(item);
        const Mark = tone === "ok" ? Check : tone === "error" ? X : Minus;
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpen(index)}
              className="relative flex w-full items-start gap-3 rounded-md pb-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&:hover_[data-slot=step-title]]:underline"
              data-testid={`run-detail-step-${index}`}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 mt-0.5 inline-grid size-5 shrink-0 place-items-center rounded-full [&_svg]:size-3",
                  STEP_MARK[tone],
                )}
              >
                <Mark />
              </span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-medium underline-offset-4" data-slot="step-title">
                  {[
                    t("workflowFlow.stepNumber", { number: index + 1 }),
                    t(kindOf(item)),
                    connector ? (connectorNames.get(connector) ?? null) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {[
                    held ? t("workflow.preview.held") : statusLabel(t, item.status),
                    effect ? t(effect === "read" ? "sideEffects.read" : "sideEffects.write") : null,
                    item.duration_ms === null ? null : formatRunDuration(locale, item.duration_ms),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function RunStepIdentityFacts({
  snapshots,
  connectorNames,
}: {
  snapshots: ReturnType<typeof stepCredentialSnapshots>;
  connectorNames: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-3 [&_[data-slot=fact-list]>div]:grid-cols-1">
      <p className="text-sm text-muted-foreground">{t("runs.step.identityEvidence")}</p>
      {snapshots.length ? (
        snapshots.map((snapshot, position) => (
          <FactList
            key={position}
            items={[
              {
                label: t("inbox.resource.connector"),
                value: connectorNames.get(snapshot.connector_id) ?? t("runs.caller.unknown"),
              },
              {
                label: t("connectorDetail.connection.speaksAs"),
                value: snapshot.identity ? (
                  <span className="[overflow-wrap:anywhere]">
                    {snapshot.identity.subject} · {snapshot.identity.issuer}
                  </span>
                ) : (
                  t("runs.caller.unknown")
                ),
              },
              {
                label: t("authority.environment"),
                value: t(
                  snapshot.environment === "prod"
                    ? "authority.production"
                    : "authority.development",
                ),
              },
              {
                label: t("runs.step.credentialGeneration"),
                value: snapshot.credential_generation ?? snapshot.access_token_version ?? MISSING,
              },
            ]}
          />
        ))
      ) : (
        <p>{t("runs.caller.unknown")}</p>
      )}
    </div>
  );
}

function RunStepSheet({
  step,
  index,
  kindOf,
  onClose,
}: {
  step: ExecutionStep;
  index: number;
  kindOf: StepKindOf;
  onClose(): void;
}) {
  const { t, locale } = useI18n();
  const session = useSession();
  const names = useNameIndex(session.permissions, true);
  const snapshots = stepCredentialSnapshots(step);
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
      title={[t("workflowFlow.stepNumber", { number: index + 1 }), t(kindOf(step))].join(" · ")}
      badge={
        <StatusBadge
          state={stepWasHeld(step) ? "pending" : step.status}
          label={stepWasHeld(step) ? t("workflow.preview.held") : undefined}
        />
      }
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
      <Section label={t("connectorDetail.connection.speaksAs")} testId="run-step-identities">
        <RunStepIdentityFacts snapshots={snapshots} connectorNames={names.connector} />
      </Section>
      {evidence.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="run-step-nothing">
          {t("runs.step.nothingRecorded")}
        </p>
      ) : null}
      <TechnicalDetails testId="run-step-technical">
        <FactList
          items={[
            {
              label: t("workflowFlow.sheet.key"),
              value: <span className="break-all font-mono text-xs">{step.step_key}</span>,
              testId: "run-step-key",
            },
          ]}
        />
        {evidence.map(({ key, label, text }) => (
          <Copyable key={key}>
            <CodeBlock
              label={label}
              code={hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
              testId={`run-step-${key}`}
            />
          </Copyable>
        ))}
      </TechnicalDetails>
    </RecordSheet>
  );
}
