import type { components } from "@cli-core/engine-api/openapi";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { listProposedPatchCandidates } from "@/api/decisions";
import { useSetup } from "@/api/setup";
import type { RunEnvironment } from "@/api/workflow-run";
import {
  absolute,
  attentionHref,
  chatNewHref,
  connectorHref,
  routerTarget,
  WORKFLOW_AUTOMATION_ANCHOR,
} from "@/app/links";
import { type ActionSpec, SectionHeading, StatusStrip } from "@/components/cockpit/patterns";
import { useConnectorRecords } from "@/features/connectors";
import { fixerKey, patchDecision } from "@/features/decisions";
import {
  ApprovalExpiryNote,
  AUTOMATION_REFRESH_MS,
  GrantWorkflowAuthority,
  invalidateWorkflowAutomation,
  liveRunEnvironment,
  OPENS_APPROVAL,
  useAuthorityCarryOver,
} from "@/features/grants";
import {
  type AutomationState,
  type AutomationWorkflow,
  automationEnvironment,
  automationEnvironmentUndecided,
  automationNeedsMoreApprovals,
  automationState,
  grantOpeningNotice,
  hookStartedOnly,
  OPENING_NOTICE_KEYS,
  recommendedAutomationEnvironment,
} from "@/features/grants/model";
import { LiveScheduleRun } from "@/features/operations";
import { WaitingOnApprover } from "@/features/overview";
import {
  failedStatusesFor,
  isExecutionRecord,
  lastRunLine,
  latestFailedRun,
} from "@/features/runs";
import { useOpenRunSheet } from "@/features/workflows/hooks/run-sheet";
import { reviewTarget } from "@/features/workflows/model/review-target";
import {
  STRIP_STATE_KEYS,
  stripActionKey,
  type WaitingConnector,
  workflowStrip,
} from "@/features/workflows/model/workflow-strip";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  authorityItems,
  automationHeadline,
  automationNow,
  automationSettled,
  hasPreparedDraft,
  openRepair,
  stripHelp,
  stripLine,
  unansweredChecks,
  verifiedStatus,
  waitingConnectorFor,
  weekStart,
  workflowSchedules,
  workflowVersions,
} from "../model/automation-panel-model";
import {
  type WorkflowDiagnosis,
  WorkflowGateDiagnosis,
  workflowDiagnosisQuery,
} from "./workflow-diagnosis";

const REFRESH_MS = AUTOMATION_REFRESH_MS;

export interface WorkflowAutomation {
  workflowId: string;
  state: AutomationState | null;
  failed: boolean;
  retry: () => void;
  diagnosis: WorkflowDiagnosis | null;
  versions: ReadonlyMap<string, number>;
  now: number;
  canWrite: boolean;
  canRun: boolean;
  canChat: boolean;
  history: { hasMore: boolean; loading: boolean; more: () => void };
  openGrant: () => void;
  grantRequest: number;
  resume: { pending: boolean; failed: boolean; run: (scheduleIds: readonly string[]) => void };
  rejectedRepairs: readonly string[];
  noteRejectedRepair: (stepId: string) => void;
  refresh: () => void;
  runEnvironment: RunEnvironment | null | undefined;
}

export function useWorkflowAutomation(
  workflowId: string,
  workflow: AutomationWorkflow,
  permissions: readonly string[],
): WorkflowAutomation {
  const client = useQueryClient();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const [grantRequest, setGrantRequest] = useState(0);
  const [rejectedRepairs, setRejectedRepairs] = useState<readonly string[]>([]);

  const authorities = useInfiniteQuery({
    queryKey: ["workflow-authorities", workflowId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiCall("get", "/v1/workflows/{id}/execution-authorities", {
        path: { id: workflowId },
        query: { limit: 20, cursor: pageParam ?? undefined },
      }),
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: REFRESH_MS,
  });
  const schedules = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () => apiCall("get", "/v1/schedules", { query: { workflow_id: workflowId } }),
    refetchInterval: REFRESH_MS,
  });
  const mayReadStatus = permissions.includes("schedule:read");
  const status = useQuery({
    queryKey: ["workflow-automation-status", workflowId],
    enabled: mayReadStatus,
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/automation-status", { path: { id: workflowId } }),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const prepared = hasPreparedDraft(workflow);
  const draft = useQuery({
    queryKey: ["workflow-draft-version", workflowId, workflow.draft_version_id],
    enabled: prepared,
    queryFn: () => apiCall("get", "/v1/workflows/{id}/draft", { path: { id: workflowId } }),
  });

  const now = automationNow(tick, [
    authorities.dataUpdatedAt,
    schedules.dataUpdatedAt,
    status.dataUpdatedAt,
  ]);
  const items = useMemo(() => authorityItems(authorities.data?.pages), [authorities.data]);
  const ownSchedules = useMemo(
    () => workflowSchedules(schedules.data?.schedules, workflowId),
    [schedules.data, workflowId],
  );
  const verified = verifiedStatus(status.data);
  const settled = automationSettled({
    authoritiesPending: authorities.isPending,
    schedulesPending: schedules.isPending,
    statusPending: status.isPending,
    draftPending: draft.isPending,
    mayReadStatus,
    prepared,
  });
  const inputs = {
    workflow,
    draft: draft.data ?? null,
    schedules: ownSchedules,
    status: verified,
    authorities: authorities.error ? null : items,
    now,
  };
  const undecided = settled && automationEnvironmentUndecided(inputs);
  const previewVersionId = reviewTarget(workflow, draft.data ?? null)?.version_id ?? null;
  const mayPreview = permissions.includes("workflow:read");
  const connectorPreview = useQuery({
    queryKey: ["workflow-connector-environment", workflowId, previewVersionId],
    enabled: undecided && mayPreview && previewVersionId !== null,
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/versions/{version_id}/authority-preview", {
        path: { id: workflowId, version_id: previewVersionId ?? "" },
        query: { environment: "dev" },
      }),
    retry: false,
  });
  const setup = useSetup(undecided);
  const previewAwaited = undecided && mayPreview && previewVersionId !== null;
  const recommendationPending =
    (previewAwaited && connectorPreview.isPending) || (undecided && setup.isPending);
  const connectorEnvironment =
    undecided && !recommendationPending
      ? recommendedAutomationEnvironment(
          previewAwaited ? (connectorPreview.data ?? null) : null,
          setup.data?.default_environment,
        )
      : null;
  const environment =
    settled && !recommendationPending
      ? automationEnvironment({ ...inputs, connectorEnvironment })
      : null;
  const mayDiagnose = permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: environment !== null && mayDiagnose,
  });
  const ready = settled && environment !== null && (!mayDiagnose || !diagnosis.isPending);
  const unanswered = unansweredChecks({
    mayReadStatus,
    statusPending: status.isPending,
    statusVerified: verified !== null,
    mayDiagnose,
    environmentKnown: environment !== null,
    diagnosisPending: diagnosis.isPending,
    diagnoses: diagnosis.data?.diagnoses,
  });
  const decided = ready
    ? automationState({
        ...inputs,
        connectorEnvironment,
        diagnosis: diagnosis.data ?? null,
        unanswered,
      })
    : null;
  const approvalOutOfSight =
    decided !== null && automationNeedsMoreApprovals(decided, Boolean(authorities.hasNextPage));
  const { fetchNextPage, isFetchingNextPage } = authorities;
  useEffect(() => {
    if (approvalOutOfSight && !isFetchingNextPage) void fetchNextPage();
  }, [approvalOutOfSight, isFetchingNextPage, fetchNextPage]);

  const versions = workflowVersions(workflow, draft.data);

  const refresh = () => void invalidateWorkflowAutomation(client, workflowId);
  const resume = useMutation({
    mutationFn: async (scheduleIds: readonly string[]) => {
      for (const id of scheduleIds)
        await apiCall("put", "/v1/schedules/{id}", { path: { id }, body: { paused: false } });
    },
    onSettled: refresh,
  });

  return {
    workflowId,
    state: approvalOutOfSight ? null : decided,
    failed: Boolean(authorities.error) || (settled && items === null),
    retry: () => void authorities.refetch(),
    diagnosis: diagnosis.data ?? null,
    versions,
    now,
    canWrite: permissions.includes("workflow:write"),
    canRun: permissions.includes("workflow:run"),
    canChat: permissions.includes("conversation:write"),
    history: {
      hasMore: Boolean(authorities.hasNextPage),
      loading: authorities.isFetching,
      more: () => void authorities.fetchNextPage(),
    },
    openGrant: () => setGrantRequest((value) => value + 1),
    grantRequest,
    resume: {
      pending: resume.isPending,
      failed: resume.isError,
      run: (scheduleIds) => resume.mutate(scheduleIds),
    },
    rejectedRepairs,
    noteRejectedRepair: (stepId) =>
      setRejectedRepairs((steps) => (steps.includes(stepId) ? steps : [...steps, stepId])),
    refresh,
    runEnvironment:
      items === null || authorities.error ? undefined : liveRunEnvironment(items, now),
  };
}

type Execution = components["schemas"]["Execution"];

function useRunHealth(workflowId: string, health: string | null, permissions: readonly string[]) {
  const [weekFrom] = useState(() => weekStart(Date.now()));
  const weekFailures = useQuery({
    queryKey: ["workflow-week-failures", workflowId, weekFrom],
    enabled: permissions.includes("execution:read"),
    queryFn: () =>
      apiCall("get", "/v1/executions", {
        query: {
          workflow_id: workflowId,
          started_from: weekFrom,
          status: failedStatusesFor("all") ?? "failed",
          limit: 1,
        },
      }),
    refetchInterval: REFRESH_MS,
  });
  const unhealthy = Boolean(health) && health !== "ok";
  const runs = useQuery({
    queryKey: ["workflow-latest-failed-run", workflowId],
    enabled: unhealthy && permissions.includes("execution:read"),
    queryFn: () =>
      apiCall("get", "/v1/executions", { query: { workflow_id: workflowId, limit: 20 } }),
  });
  const patch = useQuery({
    queryKey: ["run-open-repair", workflowId],
    enabled: permissions.includes("workflow:read"),
    queryFn: () => listProposedPatchCandidates(workflowId),
  });
  const failed = latestFailedRun((runs.data?.items ?? []).filter(isExecutionRecord));
  return {
    failedRun: failed,
    repair: openRepair(patch.data?.items),
    noRecentFailures: !weekFailures.error && weekFailures.data?.total === 0,
  };
}

function useScheduledRunInProgress(
  workflowId: string,
  permissions: readonly string[],
): string | null {
  const runs = useQuery({
    queryKey: ["workflow-active-run", workflowId],
    enabled: permissions.includes("execution:read"),
    queryFn: () =>
      apiCall("get", "/v1/executions", {
        query: {
          workflow_id: workflowId,
          status: "running",
          request_source: "scheduler",
          limit: 1,
        },
      }),
  });
  const run = (runs.data?.items ?? []).filter(isExecutionRecord)[0];
  return run && run.status === "running" ? run.id : null;
}

export function useWaitingConnector(
  steps: readonly { connectorId: string | null; connector: string | null }[],
): WaitingConnector | null {
  return waitingConnectorFor(steps, useConnectorRecords());
}

export function WorkflowStatus({
  automation,
  workflow,
  workflowName,
  health,
  disabled,
  lastRun,
  waitingConnector,
  permissions,
  noSteps = false,
  autoPaused = false,
  onOffersApproval,
  onAddStep,
}: {
  automation: WorkflowAutomation;
  workflow: AutomationWorkflow;
  workflowName: string;
  health: string | null;
  disabled: boolean;
  lastRun:
    | (Pick<Execution, "status" | "started_at" | "created_at"> & {
        held_effects?: boolean;
      })
    | null;
  waitingConnector: WaitingConnector | null;
  permissions: readonly string[];
  noSteps?: boolean;
  autoPaused?: boolean;
  onOffersApproval?: (offers: boolean) => void;
  onAddStep?: () => void;
}) {
  const { t, locale, dateTime } = useI18n();
  const { state } = automation;
  const navigate = useNavigate();
  const sheets = useOpenRunSheet();
  const runHealth = useRunHealth(automation.workflowId, health, permissions);
  const liveRunId = useScheduledRunInProgress(automation.workflowId, permissions);
  const enable = useOptimisticAction({
    queryKey: ["catalog-detail", "workflows", automation.workflowId],
    mutationFn: () =>
      apiCall("patch", "/v1/workflows/{id}/metadata", {
        path: { id: automation.workflowId },
        body: { lifecycle: "active" },
      }),

    apply: (current: Record<string, unknown> | undefined) =>
      current ? { ...current, lifecycle: "active" } : current,
    onSuccess: () => {
      toast.success(t("workflowPage.enabled", { name: workflowName }));
      automation.refresh();
    },
  });
  const strip = workflowStrip({
    automation: state,
    failed: automation.failed,
    disabled,
    noSteps,
    health,
    failedRunId: runHealth.failedRun?.id ?? null,
    repairPrepared: runHealth.repair !== null,
    waitingConnector,
    rights: { write: automation.canWrite, chat: automation.canChat },
  });
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${WORKFLOW_AUTOMATION_ANCHOR}`)
      anchor.current?.scrollIntoView({ block: "start" });
  }, []);
  const invalid = state?.state === "invalid";
  const target = state?.target ?? null;
  const carryOver = useAuthorityCarryOver({
    workflowId: automation.workflowId,
    versionId: target?.version_id,
    environment: state?.environment ?? "prod",
    activation: target?.activation,
    enabled: automation.canWrite && !invalid && strip.action?.kind === "approve",
  });
  const adoptable = strip.action?.kind === "approve" && carryOver.choice === "adopt";
  const offersApproval = strip.action?.kind === "approve";
  useEffect(() => {
    onOffersApproval?.(offersApproval);
  }, [offersApproval, onOffersApproval]);
  const opensApproval = strip.action?.kind === "approve" && !adoptable;
  const notice =
    opensApproval && state
      ? grantOpeningNotice({
          diagnoses: automation.diagnosis?.diagnoses,
          hookStarted: hookStartedOnly(state.triggers, workflow.webhooks_active),
          mayRun: automation.canRun,
        })
      : null;
  const repair = runHealth.repair ? patchDecision(runHealth.repair, "") : null;
  const repairFixer =
    repair?.detail.kind === "patch" ? fixerKey(repair.detail.evidence.fixer) : null;
  const repairDescription = repairFixer ? t(repairFixer) : repair?.summary;
  const blocked = Math.max(1, automation.diagnosis?.diagnoses.length ?? 0);
  const noticed = autoPaused && strip.kind === "paused";
  const line = stripLine(
    {
      strip,
      state,
      noticed,
      blocked,
      waitingConnector,
      failure: runHealth.failedRun?.failure ?? null,
      health,
      repairDescription,
      lastRun: lastRunLine(lastRun, t, locale),
      noRecentFailures: runHealth.noRecentFailures,
      headline: automationHeadline(state, t, dateTime),
    },
    t,
  );
  const help = stripHelp(
    {
      strip,
      notice: notice ? OPENING_NOTICE_KEYS[notice] : null,
      adoptable,
      canWrite: automation.canWrite,
    },
    t,
  );
  const action = ((): ActionSpec | null => {
    const a = strip.action;
    if (!a || noticed) return null;
    const label = t(stripActionKey(a));
    const base = { label, variant: "outline" as const, testId: "workflow-automation-action" };
    switch (a.kind) {
      case "retry":
        return { ...base, onClick: automation.retry, testId: "workflow-automation-failed-retry" };
      case "chat":
        return {
          ...base,
          href: absolute(
            chatNewHref({
              workflowId: automation.workflowId,
              prompt: t("automation.invalidPrompt"),
              references: [{ type: "workflow", id: automation.workflowId }],
            }),
          ),
        };
      case "enable":
        return { ...base, onClick: () => enable.mutate(undefined), pending: enable.isPending };
      case "resume":
        return {
          ...base,
          pending: automation.resume.pending,
          onClick: () => automation.resume.run(a.scheduleIds),
        };
      case "approve":
        return adoptable
          ? {
              ...base,
              label: t("authority.review.adopt"),
              onClick: carryOver.adopt,
              pending: carryOver.adopting,
              testId: "workflow-automation-adopt",
            }
          : { ...base, onClick: automation.openGrant, data: OPENS_APPROVAL };
      case "recheck":
        return { ...base, onClick: automation.refresh, testId: "workflow-automation-recheck" };
      case "connector":
        return { ...base, onClick: () => void navigate({ to: connectorHref(a.connectorId) }) };
      case "cause":
        return { ...base, onClick: () => sheets.run(a.runId) };
      case "addStep":
        return onAddStep
          ? {
              ...base,
              variant: "primary",
              onClick: onAddStep,
              testId: "workflow-automation-add-step",
            }
          : null;
      case "review":
        return {
          ...base,
          onClick: () =>
            void navigate(
              routerTarget(attentionHref({ review: `workflow:${automation.workflowId}` })),
            ),
        };
    }
  })();
  return (
    <div className="flex flex-col gap-3">
      <div
        ref={anchor}
        id={WORKFLOW_AUTOMATION_ANCHOR}
        className="scroll-mt-4 empty:hidden"
        data-sk-slot="workflow-automation"
        data-testid="workflow-automation"
        data-state={automation.failed ? "failed" : (state?.state ?? "loading")}
        data-strip={strip.kind}
      >
        {noticed ? null : (
          <StatusStrip
            tone={strip.tone}
            loading={strip.kind === "loading"}
            testId="workflow-status-strip"
            line={
              <>
                <span className="font-medium" data-testid="workflow-automation-state">
                  {t(STRIP_STATE_KEYS[strip.kind])}
                </span>
                {line ? (
                  <>
                    {" · "}
                    <span data-testid="workflow-automation-headline">{line}</span>
                  </>
                ) : null}
                {strip.lower.length > 0 ? (
                  <span data-testid="workflow-strip-more">
                    {t("workflowStrip.line.more", { count: strip.lower.length })}
                  </span>
                ) : null}
              </>
            }
            help={help.length > 0 ? help.join(" ") : undefined}
            aside={
              <>
                <WaitingOnApprover
                  subjectId={automation.workflowId}
                  permissions={permissions}
                  testId="workflow-strip-waiting-on"
                />
                {state?.state === "approved" && !disabled ? (
                  <ApprovalExpiryNote
                    validUntil={state.facts.untilRevoked ? null : state.facts.validUntil}
                    environment={state.environment}
                    onRenew={automation.canWrite && target ? automation.openGrant : undefined}
                    testId="workflow-expiry-strip"
                  />
                ) : null}
              </>
            }
            action={action ?? undefined}
          />
        )}
      </div>
      {liveRunId ? (
        <section
          aria-labelledby="workflow-live-run-title"
          className="grid gap-1 rounded-lg border border-border px-3 py-2"
          data-testid="workflow-live-run-panel"
        >
          <SectionHeading id="workflow-live-run-title">{t("ops.sched.live.title")}</SectionHeading>
          <LiveScheduleRun
            executionId={liveRunId}
            onOpenRun={(id) => sheets.run(id)}
            testId="workflow-live-run"
          />
        </section>
      ) : null}
      {state && !invalid && !disabled ? (
        <WorkflowGateDiagnosis
          workflowId={automation.workflowId}
          environment={state.environment}
          onOpenApproval={
            automation.canWrite && target && !opensApproval ? automation.openGrant : undefined
          }
          ownRetry={state.state !== "unknown"}
          rejectedRepairs={automation.rejectedRepairs}
          onRepairRejected={automation.noteRejectedRepair}
        />
      ) : null}
      {automation.canWrite && state && target && !invalid ? (
        <GrantWorkflowAuthority
          key={automation.workflowId}
          workflowId={automation.workflowId}
          versionId={target.version_id}
          {...(target.activation ? { activation: target.activation } : {})}
          versionLabel={t(
            target.kind === "prepared" ? "authority.versionPrepared" : "authority.versionRunning",
            { version: target.version == null ? "—" : `v${target.version}` },
          )}
          initialEnvironment={state.environment}
          openRequest={automation.grantRequest}
          onCompleted={automation.refresh}
        />
      ) : null}
    </div>
  );
}
