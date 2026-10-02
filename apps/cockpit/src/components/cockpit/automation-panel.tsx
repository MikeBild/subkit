import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Play, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { absolute, chatNewHref, WORKFLOW_AUTOMATION_ANCHOR } from "@/app/links";
import { ContextHelp } from "@/components/cockpit/context-help";
import { GrantWorkflowAuthority } from "@/components/cockpit/grant-workflow-authority";
import {
  DiagnosisTitleAction,
  type WorkflowDiagnosis,
  WorkflowGateDiagnosis,
  workflowDiagnosisQuery,
} from "@/components/cockpit/workflow-diagnosis";
import { GrantCard } from "@/components/cockpit/workflow-grants";
import { LoadFailed } from "@/components/failure-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AUTOMATION_STATE_KEYS,
  type AutomationAction,
  type AutomationState,
  type AutomationStateKind,
  type AutomationStatusLike,
  type AutomationTrigger,
  type AutomationWorkflow,
  automationActionKey,
  automationEnvironment,
  automationState,
} from "@/lib/automation-state";
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import type { WorkflowAuthority, WorkflowAuthorityList } from "@/lib/workflow-authorities";

type ScheduleList = components["schemas"]["ScheduleListResponse"];

/** How often the page looks again: an approval, a hold or a schedule can change under it. */
const REFRESH_MS = 30_000;

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
  canChat: boolean;
  history: { hasMore: boolean; loading: boolean; more: () => void };
  /** Opens the approval dialog; every caller opens the same one. */
  openGrant: () => void;
  grantRequest: number;
  /** Shows the current approval inside the panel and scrolls to it. */
  showGrant: () => void;
  grantShown: boolean;
  setGrantShown: (shown: boolean) => void;
  resume: { pending: boolean; failed: boolean; run: (scheduleIds: readonly string[]) => void };
  /** Re-reads everything the state rests on, after it was changed. */
  refresh: () => void;
}

/**
 * The reads behind a workflow's automation state, and the one decision made
 * from them (`lib/automation-state.ts`). Called once per page: the panel and
 * the action beside the title receive the same object, so they show the same
 * state and open the same dialog.
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
  const [grantShown, setGrantShown] = useState(false);

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

  const items = useMemo(
    () => authorities.data?.pages.flatMap((page) => page.items) ?? null,
    [authorities.data],
  );
  const ownSchedules = useMemo(
    () => schedules.data?.schedules.filter((entry) => entry.workflow_id === workflowId) ?? null,
    [schedules.data, workflowId],
  );
  const settled =
    !authorities.isPending &&
    !schedules.isPending &&
    (!mayReadStatus || !status.isPending) &&
    (!prepared || !draft.isPending);
  const inputs = {
    workflow,
    draft: draft.data ?? null,
    schedules: ownSchedules,
    status: status.data ?? null,
    authorities: authorities.error ? null : items,
    now,
  };
  const environment = settled ? automationEnvironment(inputs) : null;
  const diagnosis = useQuery({
    ...workflowDiagnosisQuery(workflowId, environment),
    enabled: environment !== null && permissions.includes("workflow:read"),
  });
  const ready = settled && environment !== null && !diagnosis.isPending;

  const versions = new Map<string, number>();
  if (workflow.current_version_id && typeof workflow.current_version === "number")
    versions.set(workflow.current_version_id, workflow.current_version);
  if (draft.data?.version_id && typeof draft.data.version === "number")
    versions.set(draft.data.version_id, draft.data.version);

  const refresh = () => {
    for (const queryKey of [
      ["workflow-authorities", workflowId],
      ["workflow-automation-status", workflowId],
      ["workflow-diagnosis", workflowId],
      ["workflow", workflowId, "schedules"],
      ["workflow-invocation", workflowId],
      ["catalog-detail", "workflows", workflowId],
    ])
      void client.invalidateQueries({ queryKey });
  };
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
    state: ready ? automationState({ ...inputs, diagnosis: diagnosis.data ?? null }) : null,
    failed: Boolean(authorities.error),
    retry: () => void authorities.refetch(),
    diagnosis: diagnosis.data ?? null,
    versions,
    now,
    canWrite: permissions.includes("workflow:write"),
    canChat: permissions.includes("conversation:write"),
    history: {
      hasMore: Boolean(authorities.hasNextPage),
      loading: authorities.isFetching,
      more: () => void authorities.fetchNextPage(),
    },
    openGrant: () => setGrantRequest((value) => value + 1),
    grantRequest,
    showGrant: () => {
      setGrantShown(true);
      window.requestAnimationFrame(() =>
        document
          .getElementById(WORKFLOW_AUTOMATION_ANCHOR)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    },
    grantShown,
    setGrantShown,
    resume: {
      pending: resume.isPending,
      failed: resume.isError,
      run: (scheduleIds) => resume.mutate(scheduleIds),
    },
    refresh,
  };
}

/**
 * One action of the automation state, as a button — the same component in the
 * panel and beside the title, so the label, the permission and what the press
 * does cannot differ between the two.
 *
 * `outline`, never filled: the page's one filled action is "Ausführen".
 */
export function AutomationActionButton({
  automation,
  action,
  testId,
  size = "default",
}: {
  automation: WorkflowAutomation;
  action: AutomationAction;
  testId: string;
  size?: "default" | "sm";
}) {
  const { t } = useI18n();
  const label = t(automationActionKey(action));
  switch (action.kind) {
    case "resume":
      return automation.canWrite ? (
        <Button
          variant="outline"
          size={size}
          disabled={automation.resume.pending}
          onClick={() => automation.resume.run(action.scheduleIds)}
          data-testid={testId}
        >
          <Play data-icon="inline-start" />
          {label}
        </Button>
      ) : null;
    case "apply":
    case "grant":
    case "extend":
      return automation.canWrite && automation.state?.target ? (
        <Button variant="outline" size={size} onClick={automation.openGrant} data-testid={testId}>
          <ShieldCheck data-icon="inline-start" />
          {label}
        </Button>
      ) : null;
    case "view":
      return (
        <Button variant="outline" size={size} onClick={automation.showGrant} data-testid={testId}>
          {label}
        </Button>
      );
    case "repair":
      return null;
  }
}

/**
 * The action beside the page title while the automation state has a pending
 * step: the panel's own primary action, performing the same act. Null in a
 * calm state — the caller then shows the page's ordinary action.
 */
export function AutomationTitleAction({
  automation,
  action,
  workflowName,
}: {
  automation: WorkflowAutomation;
  action: AutomationAction;
  workflowName: string;
}) {
  const { t } = useI18n();
  if (action.kind !== "repair")
    return (
      <AutomationActionButton automation={automation} action={action} testId="detail-action" />
    );
  // A block the diagnosis names: its own act. One it does not name — the
  // engine reported a refusal the diagnosis could not explain — goes to an author.
  if (automation.diagnosis?.diagnoses[0] && automation.state)
    return (
      <DiagnosisTitleAction
        diagnosis={automation.diagnosis}
        environment={automation.state.environment}
        via={action.via}
      />
    );
  return automation.canChat ? (
    <Button asChild variant="outline">
      <a
        href={absolute(
          chatNewHref({
            workflowId: automation.workflowId,
            prompt: t("automation.repairPrompt", { name: workflowName }),
          }),
        )}
        data-testid="detail-action"
      >
        <Bot data-icon="inline-start" />
        {t("remedy.chat")}
      </a>
    </Button>
  ) : null;
}

const STATE_TONE: Record<AutomationStateKind, string> = {
  approved: "bg-success",
  grant: "bg-warning",
  apply: "bg-warning",
  repair: "bg-destructive",
  paused: "bg-muted-foreground",
  manual: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};

function useEnvironmentWord() {
  const { t } = useI18n();
  return (environment: "dev" | "prod") =>
    t(environment === "prod" ? "authority.production" : "authority.development");
}

/** The sentence beside the state word — the facts a reader decides by. */
function useHeadline(state: AutomationState): string {
  const { t, dateTime } = useI18n();
  const environmentWord = useEnvironmentWord();
  const version = state.facts.version === null ? null : `v${state.facts.version}`;
  const versionFact = version ? t("automation.fact.version", { version }) : null;
  switch (state.state) {
    case "approved":
      return [
        versionFact,
        environmentWord(state.environment),
        state.facts.validUntil
          ? t("automation.fact.until", { until: dateTime(state.facts.validUntil) })
          : null,
        state.facts.runsLeft !== null && state.facts.runsMax !== null
          ? t("automation.fact.runs", { left: state.facts.runsLeft, max: state.facts.runsMax })
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
    case "paused":
      return t("automation.headline.paused");
    case "unknown":
      return t("automation.headline.unknown");
    case "manual":
      return state.facts.inactive
        ? t("automation.headline.inactive")
        : [versionFact, t("automation.headline.manual")].filter(Boolean).join(" · ");
  }
}

/** What starts the workflow on its own, in one line. */
function TriggerLine({
  triggers,
  hiddenHooks,
}: {
  triggers: readonly AutomationTrigger[];
  hiddenHooks: number;
}) {
  const { t, locale } = useI18n();
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
  if (parts.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="workflow-automation-triggers">
      {parts.join(" · ")}
    </p>
  );
}

/**
 * "Automatischer Betrieb": whether this workflow may run on its own — one
 * state, the facts that head it, and one action. It replaces the jump link
 * beside the title, the section button that stayed after an approval and the
 * "review needed" badges; the gate's diagnosis and the current approval are
 * embedded here, so nothing about the approval is said in a second place.
 */
export function AutomationPanel({
  automation,
  workflow,
  workflowName,
}: {
  automation: WorkflowAutomation;
  workflow: AutomationWorkflow;
  workflowName: string;
}) {
  const { t } = useI18n();
  const { state } = automation;
  return (
    <section
      id={WORKFLOW_AUTOMATION_ANCHOR}
      data-family-slot="workflow-automation"
      data-testid="workflow-automation"
      data-state={state?.state ?? (automation.failed ? "failed" : "loading")}
      className="flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-center gap-1">
        <h2 className="text-sm font-semibold">{t("automation.title")}</h2>
        <ContextHelp label={t("automation.help.label")} testId="workflow-automation-help">
          {t("automation.help")}
        </ContextHelp>
      </div>
      {automation.failed ? (
        <LoadFailed
          title={t("authority.loadFailed")}
          onRetry={automation.retry}
          testId="workflow-automation-failed"
        />
      ) : state ? (
        <PanelBody
          automation={automation}
          state={state}
          workflow={workflow}
          workflowName={workflowName}
        />
      ) : (
        <Skeleton className="h-10 w-full" data-testid="workflow-automation-loading" />
      )}
    </section>
  );
}

function PanelBody({
  automation,
  state,
  workflow,
  workflowName,
}: {
  automation: WorkflowAutomation;
  state: AutomationState;
  workflow: AutomationWorkflow;
  workflowName: string;
}) {
  const { t } = useI18n();
  const headline = useHeadline(state);
  const { target } = state;
  const listedHooks = state.triggers.filter((trigger) => trigger.kind === "hook").length;
  const hiddenHooks = listedHooks === 0 ? (workflow.webhooks_active ?? 0) : 0;
  // In state `repair` the act is the diagnosis block's own button below; a
  // second one here would be the same press twice. Only a refusal the
  // diagnosis does not name gets the way to an author.
  const unnamedRepair =
    state.primaryAction?.kind === "repair" && !automation.diagnosis?.diagnoses[0];
  const actions = [state.primaryAction, state.secondaryAction].filter(
    (action): action is AutomationAction => action !== null && action.kind !== "repair",
  );
  const needsRight =
    !automation.canWrite &&
    actions.some((action) => action.kind !== "view") &&
    state.state !== "manual";
  const current: WorkflowAuthority[] = state.grant
    ? [state.grant, ...state.alsoValid]
    : state.alsoValid;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className="inline-flex items-center gap-1.5 text-sm font-semibold"
            data-testid="workflow-automation-state"
          >
            <span
              aria-hidden="true"
              className={cn("size-2 rounded-full", STATE_TONE[state.state])}
            />
            {t(AUTOMATION_STATE_KEYS[state.state])}
          </span>
          <span className="min-w-0 text-sm" data-testid="workflow-automation-headline">
            {headline}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action, index) => (
            <AutomationActionButton
              key={action.kind}
              automation={automation}
              action={action}
              size="sm"
              testId={index === 0 ? "workflow-automation-action" : "workflow-automation-secondary"}
            />
          ))}
          {unnamedRepair && automation.canChat ? (
            <Button asChild variant="outline" size="sm">
              <a
                href={absolute(
                  chatNewHref({
                    workflowId: automation.workflowId,
                    prompt: t("automation.repairPrompt", { name: workflowName }),
                  }),
                )}
                data-testid="workflow-automation-action"
              >
                <Bot data-icon="inline-start" />
                {t("remedy.chat")}
              </a>
            </Button>
          ) : null}
          {state.state === "unknown" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={automation.refresh}
              data-testid="workflow-automation-recheck"
            >
              {t("automation.action.recheck")}
            </Button>
          ) : null}
        </div>
      </div>
      {needsRight ? (
        <p className="text-sm text-muted-foreground" data-testid="workflow-automation-no-right">
          {t("automation.noRight")}
        </p>
      ) : null}
      {automation.resume.failed ? (
        <p className="text-sm text-destructive" role="alert">
          {t("automation.resumeFailed")}
        </p>
      ) : null}
      <TriggerLine triggers={state.triggers} hiddenHooks={hiddenHooks} />
      {/* Why the gate holds it and what removes that — in the environment the
          approval itself is judged in. Renders nothing when nothing is held. */}
      <WorkflowGateDiagnosis
        workflowId={automation.workflowId}
        environment={state.environment}
        onOpenApproval={automation.canWrite && target ? automation.openGrant : undefined}
      />
      {automation.grantShown && current.length > 0 ? (
        <div className="grid gap-3" data-testid="workflow-automation-grants">
          {current.map((authority, index) => (
            <GrantCard
              key={authority.id}
              authority={authority}
              versions={automation.versions}
              now={automation.now}
              canWrite={automation.canWrite}
              testId={index === 0 && state.grant ? "authority-current" : `authority-valid-${index}`}
            />
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 w-fit"
            onClick={() => automation.setGrantShown(false)}
            data-testid="workflow-automation-grants-hide"
          >
            {t("automation.action.hide")}
          </Button>
        </div>
      ) : null}
      {automation.canWrite && target ? (
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
        />
      ) : null}
    </>
  );
}
