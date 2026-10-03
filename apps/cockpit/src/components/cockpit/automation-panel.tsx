import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import {
  absolute,
  attentionHref,
  chatNewHref,
  routerTarget,
  WORKFLOW_AUTOMATION_ANCHOR,
} from "@/app/links";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import { ActionMenu, type ActionMenuItem, StatusStrip } from "@/components/cockpit/patterns";
import { useOpenRunSheet } from "@/components/cockpit/run-sheet";
import {
  type WorkflowDiagnosis,
  WorkflowGateDiagnosis,
  workflowDiagnosisQuery,
} from "@/components/cockpit/workflow-diagnosis";
import { AUTOMATION_REFRESH_MS, invalidateWorkflowAutomation } from "@/lib/automation-queries";
import {
  type AutomationState,
  type AutomationStatusLike,
  type AutomationTrigger,
  type AutomationWorkflow,
  automationEnvironment,
  automationNeedsMoreApprovals,
  automationState,
} from "@/lib/automation-state";
import { causeClassLabel } from "@/lib/cause-class";
import { cronWords } from "@/lib/cron-words";
import { grantOpeningNotice, hookStartedOnly, OPENING_NOTICE_KEYS } from "@/lib/grant-context";
import { LOCALE_TAGS, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import type { WorkflowAuthorityList } from "@/lib/workflow-authorities";
import {
  STRIP_STATE_KEYS,
  type StripAction,
  stripActionKey,
  workflowStrip,
} from "@/lib/workflow-strip";
import { isExecutionRecord, latestFailedRun } from "@/pages/runs-model";

/** The words of a catalogue label, machine value or not. */
const catalogText = (label: { text: string }) => label.text;

type ScheduleList = components["schemas"]["ScheduleListResponse"];

const REFRESH_MS = AUTOMATION_REFRESH_MS;

export interface WorkflowAutomation {
  workflowId: string;
  /** Null until the reads it rests on have answered. */
  state: AutomationState | null;
  /** The approvals could not be read — the state would be a guess. */
  failed: boolean;
  retry: () => void;
  diagnosis: WorkflowDiagnosis | null;
  /** The versions this page can name by number. */
  versions: ReadonlyMap<string, number>;
  now: number;
  canWrite: boolean;
  canRun: boolean;
  canChat: boolean;
  history: { hasMore: boolean; loading: boolean; more: () => void };
  /** Opens the approval dialog; every caller opens the same one. */
  openGrant: () => void;
  grantRequest: number;
  resume: { pending: boolean; failed: boolean; run: (scheduleIds: readonly string[]) => void };
  /** The steps whose computed repair was refused: only an author can change them now. */
  rejectedRepairs: readonly string[];
  noteRejectedRepair: (stepId: string) => void;
  /** Re-reads everything the state rests on, after it was changed. */
  refresh: () => void;
}

/**
 * The reads behind a workflow's automation state, and the one decision made
 * from them (`lib/automation-state.ts`). Called once per page: the panel
 * shows the state and carries its action, and whatever else on the page speaks
 * about the state reads this object instead of deciding again.
 */
export function useWorkflowAutomation(
  workflowId: string,
  workflow: AutomationWorkflow,
  permissions: readonly string[],
): WorkflowAutomation {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  const [grantRequest, setGrantRequest] = useState(0);
  const [rejectedRepairs, setRejectedRepairs] = useState<readonly string[]>([]);

  const authorities = useInfiniteQuery({
    queryKey: ["workflow-authorities", workflowId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiRequest<WorkflowAuthorityList>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/execution-authorities?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    getNextPageParam: (page) => page.next_cursor,
    refetchInterval: REFRESH_MS,
  });
  const schedules = useQuery({
    queryKey: ["workflow", workflowId, "schedules"],
    queryFn: () =>
      apiRequest<ScheduleList>(`/v1/schedules?workflow_id=${encodeURIComponent(workflowId)}`),
    refetchInterval: REFRESH_MS,
  });
  // The verified answer needs `schedule:read`. Without it the state is decided
  // from the schedules and approvals alone, never assumed to be fine.
  const mayReadStatus = permissions.includes("schedule:read");
  const status = useQuery({
    queryKey: ["workflow-automation-status", workflowId],
    enabled: mayReadStatus,
    queryFn: () =>
      apiRequest<AutomationStatusLike>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/automation-status`,
      ),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const prepared =
    typeof workflow.draft_version_id === "string" &&
    workflow.draft_version_id !== workflow.current_version_id;
  // Only for the number in the sentence — which version the approval judges is
  // already decided by the record.
  const draft = useQuery({
    queryKey: ["workflow-draft-version", workflowId, workflow.draft_version_id],
    enabled: prepared,
    queryFn: () =>
      apiRequest<{ version_id: string; version: number }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/draft`,
      ),
  });

  // An answer of another shape is a failed read, never an empty list: "no
  // approvals" and "no schedules" are states the page acts on.
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
  const environment = settled ? automationEnvironment(inputs) : null;
  const mayDiagnose = permissions.includes("workflow:read");
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: environment !== null && mayDiagnose,
  });
  // A read that is never made is not one to wait for.
  const ready = settled && environment !== null && (!mayDiagnose || !diagnosis.isPending);
  // A read that was made and did not answer — an error, or an answer of
  // another shape — is not the same as one the reader may not make: the
  // state then says "not verified" instead of deciding without it.
  const unanswered = {
    status: mayReadStatus && !status.isPending && verified === null,
    diagnosis:
      mayDiagnose &&
      environment !== null &&
      !diagnosis.isPending &&
      !Array.isArray(diagnosis.data?.diagnoses),
  };
  const decided = ready
    ? automationState({ ...inputs, diagnosis: diagnosis.data ?? null, unanswered })
    : null;
  // The approval in force can lie behind the first page of newer ones; read on
  // until it is found rather than say "approved" with nothing to show for it.
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
        await apiRequest(`/v1/schedules/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ paused: false }),
        });
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
  };
}

type ExecutionList = components["schemas"]["ExecutionListResponse"];

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: "dev" | "prod") =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

/** The facts beside the state word — what a reader decides by. */
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
    case "legacy":
      return t("automation.headline.legacy");
    case "paused":
      // Paused with nothing to resume: only a hook is stopped, and the engine
      // has no act that switches one back on. Said, instead of a dead button.
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

/** What starts the workflow on its own, as words — the summary of "Verwenden". */
export function useTriggerWords(): (
  triggers: readonly AutomationTrigger[],
  hiddenHooks: number,
) => string[] {
  const { t, locale } = useI18n();
  return (triggers, hiddenHooks) => {
    const parts = triggers.map((trigger) => {
      const text =
        trigger.kind === "schedule"
          ? t("automation.trigger.schedule", {
              when: cronWords(trigger.cron ?? "", t, LOCALE_TAGS[locale]),
              timezone: trigger.timezone ?? "UTC",
            })
          : t("automation.trigger.hook", { slug: trigger.slug ?? "" });
      return trigger.paused ? t("automation.trigger.paused", { trigger: text }) : text;
    });
    if (hiddenHooks > 0) parts.push(t("automation.trigger.hooks", { count: hiddenHooks }));
    return parts;
  };
}

/**
 * The newest failed run of this workflow and an open repair — the two facts
 * beside the automation decision that the strip orders it against.
 */
function useRunHealth(workflowId: string, health: string | null, permissions: readonly string[]) {
  const unhealthy = Boolean(health) && health !== "ok";
  const runs = useQuery({
    queryKey: ["workflow-latest-failed-run", workflowId],
    enabled: unhealthy && permissions.includes("execution:read"),
    // The list filters by ONE status, and the engine counts three as failed
    // (failed, timed_out, aborted): the newest twenty are read and judged here.
    queryFn: () =>
      apiRequest<ExecutionList>(
        `/v1/executions?workflow_id=${encodeURIComponent(workflowId)}&limit=20`,
      ),
  });
  const patch = useQuery({
    queryKey: ["run-open-repair", workflowId],
    enabled: permissions.includes("workflow:read"),
    queryFn: () =>
      apiRequest<{ items: { id: string }[] }>(
        `/v1/patch-candidates?status=proposed&workflow_id=${encodeURIComponent(workflowId)}&limit=1`,
      ),
  });
  const failed = latestFailedRun((runs.data?.items ?? []).filter(isExecutionRecord));
  return {
    failedRun: failed,
    repairPrepared: (patch.data?.items?.length ?? 0) > 0,
  };
}

/** The sentence a failing workflow's strip says: where its newest failed run stopped. */
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

/**
 * A workflow's state in one line (P3) — whether it may run on its own, whether
 * its runs fail, whether a repair waits — and the one action of the top state
 * (D15). The approval dialog it opens is mounted here, once; the gate's own
 * diagnosis stands right below it while a step is refused.
 */
export function WorkflowStatus({
  automation,
  workflow,
  workflowName,
  health,
  permissions,
}: {
  automation: WorkflowAutomation;
  workflow: AutomationWorkflow;
  workflowName: string;
  /** The engine's run health of the workflow. */
  health: string | null;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const { state } = automation;
  const navigate = useNavigate();
  const sheets = useOpenRunSheet();
  const runHealth = useRunHealth(automation.workflowId, health, permissions);
  const failingLine = useFailingLine();
  const headline = useHeadline(state);
  const strip = workflowStrip({
    automation: state,
    failed: automation.failed,
    health,
    failedRunId: runHealth.failedRun?.id ?? null,
    repairPrepared: runHealth.repairPrepared,
    rights: { write: automation.canWrite, chat: automation.canChat },
  });
  // A link that names the strip lands on it. The browser's own jump happens
  // before the record has loaded and the strip exists, so it is made here.
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${WORKFLOW_AUTOMATION_ANCHOR}`)
      anchor.current?.scrollIntoView({ block: "start" });
  }, []);
  const legacy = state?.state === "legacy";
  const target = state?.target ?? null;
  const opensApproval = strip.action?.kind === "approve";
  const notice =
    opensApproval && state
      ? grantOpeningNotice({
          diagnoses: automation.diagnosis?.diagnoses,
          hookStarted: hookStartedOnly(state.triggers, workflow.webhooks_active),
          mayRun: automation.canRun,
        })
      : null;
  const facts =
    strip.kind === "failing"
      ? failingLine(runHealth.failedRun?.failure ?? null, health ?? "failing")
      : strip.kind === "failed"
        ? t("authority.loadFailed")
        : strip.kind === "repairPrepared"
          ? t("workflowStrip.headline.repairPrepared")
          : headline;
  // The one approval dialog of the page: its own trigger is the strip's
  // action where approving is the next step, and it is opened by request
  // (`openRequest`) from the diagnosis otherwise.
  const grant =
    automation.canWrite && state && target && !legacy
      ? (label: string | null) => (
          <GrantWorkflowAuthority
            key={`${automation.workflowId}:${target.version_id}`}
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
            withTrigger={label !== null}
            triggerLabel={label ?? undefined}
            triggerTestId="workflow-automation-action"
            triggerSize="default"
          />
        )
      : null;
  const help = [
    ...strip.lower.map((kind) => t(STRIP_STATE_KEYS[kind])),
    ...(!automation.canWrite && strip.action === null && strip.kind !== "approved"
      ? [t("automation.noRight")]
      : []),
  ];
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
          testId="workflow-status-strip"
          line={
            <>
              <span className="font-medium" data-testid="workflow-automation-state">
                {t(STRIP_STATE_KEYS[strip.kind])}
              </span>
              {facts ? (
                <>
                  {" · "}
                  <span data-testid="workflow-automation-headline">{facts}</span>
                </>
              ) : null}
            </>
          }
          help={help.length > 0 ? help.join(" · ") : undefined}
          more={
            notice || strip.lower.length > 0 ? (
              <>
                {notice ? (
                  <span data-testid="grant-opening-notice">{t(OPENING_NOTICE_KEYS[notice])}</span>
                ) : null}
                {notice && strip.lower.length > 0 ? " · " : null}
                {strip.lower.length > 0 ? (
                  <span data-testid="workflow-strip-more">
                    {t("workflowStrip.more", { count: strip.lower.length })}
                  </span>
                ) : null}
              </>
            ) : undefined
          }
          action={
            strip.action?.kind === "approve" ? (
              grant ? (
                grant(t(stripActionKey(strip.action)))
              ) : null
            ) : strip.action ? (
              <StripActionButton
                action={strip.action}
                automation={automation}
                workflowName={workflowName}
                onOpenRun={sheets.run}
                onReview={() =>
                  void navigate(
                    routerTarget(attentionHref({ review: `workflow:${automation.workflowId}` })),
                  )
                }
              />
            ) : undefined
          }
        />
      </div>
      {/* Why the gate holds it and what removes that — in the environment the
          approval itself is judged in. Renders nothing when nothing is held.
          A version in an earlier format is not judged by the gate at all. */}
      {state && !legacy ? (
        <WorkflowGateDiagnosis
          workflowId={automation.workflowId}
          environment={state.environment}
          // The approval has one opener. Where the strip's action is that
          // opener, the diagnosis names it and adds none.
          onOpenApproval={
            automation.canWrite && target && !opensApproval ? automation.openGrant : undefined
          }
          // "Erneut prüfen" in the strip re-reads the diagnosis with everything else.
          ownRetry={state.state !== "unknown"}
          rejectedRepairs={automation.rejectedRepairs}
          onRepairRejected={automation.noteRejectedRepair}
        />
      ) : null}
      {/* Without an opener in the strip the dialog still answers the
          diagnosis' request ("Freigabe öffnen" for a sample call). */}
      {grant && !opensApproval ? grant(null) : null}
    </div>
  );
}

function StripActionButton({
  action,
  automation,
  workflowName,
  onOpenRun,
  onReview,
}: {
  action: StripAction;
  automation: WorkflowAutomation;
  workflowName: string;
  onOpenRun: (runId: string) => void;
  onReview: () => void;
}) {
  const { t } = useI18n();
  const label = t(stripActionKey(action));
  const item = ((): ActionMenuItem => {
    switch (action.kind) {
      case "retry":
        return { label, onSelect: automation.retry, testId: "workflow-automation-failed-retry" };
      case "chat": {
        const prompt: TranslationKey =
          automation.state?.state === "legacy"
            ? "automation.legacyPrompt"
            : "automation.repairPrompt";
        return {
          label,
          href: absolute(
            chatNewHref({
              workflowId: automation.workflowId,
              prompt: t(prompt, { name: workflowName }),
            }),
          ),
          testId: "workflow-automation-action",
        };
      }
      case "resume":
        return {
          label,
          disabled: automation.resume.pending,
          onSelect: () => automation.resume.run(action.scheduleIds),
          testId: "workflow-automation-action",
        };
      // The approval dialog renders its own opener (see `WorkflowStatus`).
      case "approve":
        return { label, onSelect: automation.openGrant, testId: "workflow-automation-action" };
      case "recheck":
        return { label, onSelect: automation.refresh, testId: "workflow-automation-recheck" };
      case "cause":
        return {
          label,
          onSelect: () => onOpenRun(action.runId),
          testId: "workflow-automation-action",
        };
      case "review":
        return { label, onSelect: onReview, testId: "workflow-automation-action" };
    }
  })();
  return <ActionMenu items={[item]} />;
}
