import type { components } from "@cli-core/engine-api/openapi";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { listProposedPatchCandidates } from "@/api/decisions";
import {
  absolute,
  attentionHref,
  chatNewHref,
  connectorHref,
  routerTarget,
  WORKFLOW_AUTOMATION_ANCHOR,
} from "@/app/links";
import { ApprovalExpiryNote } from "@/components/cockpit/approval-expiry-note";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { OPENS_APPROVAL } from "@/components/cockpit/opens-approval";
import { type ActionSpec, SideStatus, StatusStrip } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import { WaitingOnApprover } from "@/components/cockpit/waiting-on";
import {
  type WorkflowDiagnosis,
  WorkflowGateDiagnosis,
  workflowDiagnosisQuery,
} from "@/components/cockpit/workflow-diagnosis";
import {
  AUTOMATION_REFRESH_MS,
  invalidateWorkflowAutomation,
  useAuthorityCarryOver,
} from "@/lib/automation-queries";
import {
  type AutomationState,
  type AutomationWorkflow,
  automationEnvironment,
  automationEnvironmentUndecided,
  automationNeedsMoreApprovals,
  automationState,
  recommendedAutomationEnvironment,
} from "@/lib/automation-state";
import { causeClassLabel } from "@/lib/cause-class";
import { connectorAuthState } from "@/lib/connector-auth-state";
import { grantOpeningNotice, hookStartedOnly, OPENING_NOTICE_KEYS } from "@/lib/grant-context";
import { useI18n } from "@/lib/i18n-context";
import { reviewTarget } from "@/lib/review-target";
import { liveRunEnvironment, type RunEnvironment } from "@/lib/run-availability";
import { statusLabel } from "@/lib/status-label";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import {
  STRIP_STATE_KEYS,
  stripActionKey,
  type WaitingConnector,
  workflowStrip,
} from "@/lib/workflow-strip";
import { fixerKey } from "@/pages/decisions-context";
import { patchDecision } from "@/pages/decisions-model";
import {
  failedStatusesFor,
  isExecutionRecord,
  lastRunLine,
  latestFailedRun,
} from "@/pages/runs-model";

const catalogText = (label: { text: string }) => label.text;

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
  const prepared =
    typeof workflow.draft_version_id === "string" &&
    workflow.draft_version_id !== workflow.current_version_id;
  const draft = useQuery({
    queryKey: ["workflow-draft-version", workflowId, workflow.draft_version_id],
    enabled: prepared,
    queryFn: () => apiCall("get", "/v1/workflows/{id}/draft", { path: { id: workflowId } }),
  });

  const now = Math.max(
    tick,
    authorities.dataUpdatedAt,
    schedules.dataUpdatedAt,
    status.dataUpdatedAt,
  );
  const items = useMemo(() => {
    const pages = authorities.data?.pages;
    if (!pages || pages.some((page) => !Array.isArray(page?.items))) return null;
    return pages.flatMap((page) => page.items);
  }, [authorities.data]);
  const ownSchedules = useMemo(
    () =>
      Array.isArray(schedules.data?.schedules)
        ? schedules.data.schedules.filter((entry) => entry.workflow_id === workflowId)
        : null,
    [schedules.data, workflowId],
  );
  const verified =
    Array.isArray(status.data?.schedules) && Array.isArray(status.data?.inbound_hooks)
      ? status.data
      : null;
  const settled =
    !authorities.isPending &&
    !schedules.isPending &&
    (!mayReadStatus || !status.isPending) &&
    (!prepared || !draft.isPending);
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
  const connectorEnvironment =
    undecided && !connectorPreview.isPending
      ? recommendedAutomationEnvironment(connectorPreview.data ?? null)
      : null;
  const environment =
    settled && !(undecided && mayPreview && previewVersionId !== null && connectorPreview.isPending)
      ? automationEnvironment({ ...inputs, connectorEnvironment })
      : null;
  const mayDiagnose = permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: environment !== null && mayDiagnose,
  });
  const ready = settled && environment !== null && (!mayDiagnose || !diagnosis.isPending);
  const unanswered = {
    status: mayReadStatus && !status.isPending && verified === null,
    diagnosis:
      mayDiagnose &&
      environment !== null &&
      !diagnosis.isPending &&
      !Array.isArray(diagnosis.data?.diagnoses),
  };
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

  const versions = new Map<string, number>();
  if (workflow.current_version_id && typeof workflow.current_version === "number")
    versions.set(workflow.current_version_id, workflow.current_version);
  if (draft.data?.version_id && typeof draft.data.version === "number")
    versions.set(draft.data.version_id, draft.data.version);

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

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: "dev" | "prod") =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

function useHeadline(state: AutomationState | null): string | null {
  const { t, dateTime } = useI18n();
  const environmentWord = useEnvironmentWord();
  if (!state) return null;
  const version = state.facts.version === null ? null : `v${state.facts.version}`;
  const versionFact = version ? t("automation.fact.version", { version }) : null;
  switch (state.state) {
    case "approved":
      return [
        versionFact,
        environmentWord(state.environment),
        state.facts.untilRevoked
          ? t("automation.fact.untilRevoked")
          : state.facts.validUntil
            ? t("automation.fact.until", { until: dateTime(state.facts.validUntil) })
            : null,
        state.facts.runsLeft !== null && state.facts.runsMax !== null
          ? t("automation.fact.runs", { left: state.facts.runsLeft, max: state.facts.runsMax })
          : state.facts.runsSoFar !== null
            ? t(
                state.facts.runsSoFar === 1
                  ? "automation.fact.runsSoFar.one"
                  : "automation.fact.runsSoFar.other",
                { count: state.facts.runsSoFar },
              )
            : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "grant":
      return version
        ? t("automation.headline.grant", {
            version,
            environment: environmentWord(state.environment),
          })
        : t("automation.headline.grantUnnamed");
    case "repair":
      return state.facts.blockedStep
        ? t("automation.headline.repair", { step: state.facts.blockedStep })
        : t("automation.headline.repairUnnamed");
    case "apply": {
      const active = version ?? t("authority.noneActive");
      return state.facts.preparedVersion === null
        ? t("automation.headline.applyUnnamed", { active })
        : t("automation.headline.apply", {
            prepared: `v${state.facts.preparedVersion}`,
            active,
          });
    }
    case "invalid":
      return t("automation.headline.invalid");
    case "paused":
      return state.primaryAction === null
        ? t("automation.hookOff")
        : t("automation.headline.paused");
    case "unknown":
      return t("automation.headline.unknown");
    case "manual":
      return state.facts.inactive
        ? t("automation.headline.inactive")
        : [versionFact, t("automation.headline.manual")].filter(Boolean).join(" · ");
  }
}

function useRunHealth(workflowId: string, health: string | null, permissions: readonly string[]) {
  const [weekFrom] = useState(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
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
    repair: patch.data?.items.find((item) => item.reviewable && item.review_digest) ?? null,
    noRecentFailures: !weekFailures.error && weekFailures.data?.total === 0,
  };
}

function useFailingLine(): (
  failure: { cause_class?: string | null; step_key?: string | null } | null,
  health: string,
) => string {
  const { t } = useI18n();
  return (failure, health) => {
    const cause = failure?.cause_class && failure.cause_class !== "ok" ? failure.cause_class : null;
    if (!cause) return t("detail.cause.noRun", { state: statusLabel(t, health) });
    const words = catalogText(causeClassLabel(cause, t));
    return failure?.step_key
      ? t("detail.cause.atStep", { step: failure.step_key, cause: words })
      : t("detail.cause.class", { cause: words });
  };
}

export function useWaitingConnector(
  steps: readonly { connectorId: string | null; connector: string | null }[],
): WaitingConnector | null {
  const records = useConnectorRecords();
  for (const step of steps) {
    const record = records.find(
      (item) =>
        (step.connectorId !== null && item.id === step.connectorId) ||
        (step.connector !== null && item.slug === step.connector),
    );
    if (!record) continue;
    const state = connectorAuthState(record);
    if (state === "expired" || state === "credentials_missing")
      return {
        id: record.id,
        name: record.display_name,
        state: state === "expired" ? "expired" : "missing",
      };
  }
  return null;
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
}) {
  const { t, locale } = useI18n();
  const environmentWord = useEnvironmentWord();
  const { state } = automation;
  const navigate = useNavigate();
  const sheets = useOpenRunSheet();
  const runHealth = useRunHealth(automation.workflowId, health, permissions);
  const failingLine = useFailingLine();
  const headline = useHeadline(state);
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
  const version = (value: number | null | undefined) =>
    value === null || value === undefined ? t("authority.noneActive") : `v${value}`;
  const repair = runHealth.repair ? patchDecision(runHealth.repair, "") : null;
  const repairFixer =
    repair?.detail.kind === "patch" ? fixerKey(repair.detail.evidence.fixer) : null;
  const repairDescription = repairFixer ? t(repairFixer) : repair?.summary;
  const blocked = Math.max(1, automation.diagnosis?.diagnoses.length ?? 0);
  const noticed = autoPaused && strip.kind === "paused";
  const line = ((): string | null => {
    switch (strip.kind) {
      case "loading":
        return null;
      case "empty":
        return t("workflowStrip.line.empty");
      case "failed":
        return t("authority.loadFailed");
      case "disabled":
        return t("workflowStrip.line.disabled");
      case "paused":
        if (noticed) return null;
        return state?.primaryAction === null
          ? t("automation.hookOff")
          : t("workflowStrip.line.paused");
      case "stopped":
        return t("workflowStrip.line.stopped", {
          environment: environmentWord(state?.environment ?? "prod"),
        });
      case "repair":
        return t(
          blocked === 1 ? "workflowStrip.line.blocked.one" : "workflowStrip.line.blocked.other",
          { count: blocked },
        );
      case "unapproved":
        return state?.state === "grant"
          ? t("workflowStrip.line.neverApproved", { version: version(state.facts.version) })
          : t("workflowStrip.line.unapproved");
      case "grant":
        return t("workflowStrip.line.grant", {
          version: version(state?.facts.version),
          environment: environmentWord(state?.environment ?? "prod"),
        });
      case "apply":
        return t("workflowStrip.line.apply", {
          prepared: version(state?.facts.preparedVersion),
          active: version(state?.facts.version),
        });
      case "connector":
        return waitingConnector
          ? t(
              waitingConnector.state === "deleted"
                ? "workflowStrip.line.connectorDeleted"
                : waitingConnector.state === "expired"
                  ? "workflowStrip.line.connectorExpired"
                  : "workflowStrip.line.connectorMissing",
              { name: waitingConnector.name },
            )
          : null;
      case "failing":
        return failingLine(runHealth.failedRun?.failure ?? null, health ?? "failing");
      case "repairPrepared":
        return repairDescription ?? t("workflowStrip.headline.repairPrepared");
      case "approved":
      case "manual":
        return [
          lastRunLine(lastRun, t, locale),
          runHealth.noRecentFailures ? t("workflowStrip.line.noRecentFailures") : null,
        ]
          .filter(Boolean)
          .join(" · ");
      default:
        return headline;
    }
  })();
  const help = [
    ...(strip.lower.length > 0
      ? [
          t("workflowStrip.also", {
            states: strip.lower.map((kind) => t(STRIP_STATE_KEYS[kind])).join(", "),
          }),
        ]
      : []),
    ...(notice && !adoptable ? [t(OPENING_NOTICE_KEYS[notice])] : []),
    ...(adoptable ? [t("authority.review.help.adopt")] : []),
    ...(!automation.canWrite &&
    strip.action === null &&
    (strip.tone === "warn" || strip.tone === "error")
      ? [t("automation.noRight")]
      : []),
  ];
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
        className="scroll-mt-4"
        data-family-slot="workflow-automation"
        data-testid="workflow-automation"
        data-state={automation.failed ? "failed" : (state?.state ?? "loading")}
        data-strip={strip.kind}
      >
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
      </div>
      <SideStatus
        tone={strip.tone}
        loading={strip.kind === "loading"}
        line={[t(STRIP_STATE_KEYS[strip.kind]), line].filter(Boolean).join(" · ")}
      />
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
