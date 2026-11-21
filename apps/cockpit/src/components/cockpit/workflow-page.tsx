import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { useActorDirectory } from "@/app/actor-directory";
import {
  absolute,
  chatNewHref,
  connectorHref,
  runHref,
  WORKFLOW_RUN_ANCHOR,
  type WorkflowSection,
  workflowSectionAnchor,
  workflowSectionFromHash,
  workflowSectionHref,
} from "@/app/links";
import { useSession } from "@/app/session";
import { useShowSideDetails } from "@/app/side-panel";
import {
  useWaitingConnector,
  useWorkflowAutomation,
  WorkflowStatus,
} from "@/components/cockpit/automation-panel";
import {
  CatalogCategoryChip,
  CatalogPurpose,
  useCatalogMetadataActions,
} from "@/components/cockpit/catalog-metadata";
import { recordCategory } from "@/components/cockpit/catalog-metadata-model";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import {
  type ConnectorEnvironment,
  EnvironmentChip,
  isConnectorEnvironment,
} from "@/components/cockpit/environment-chip";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  CodeBlock,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DetailPage,
  type Fact,
  FactList,
  type PageTab,
  SideDetails,
  SideSection,
  STATUS_DOT,
  statusTone,
  TabBody,
  useSideDetailsAvailable,
} from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import {
  ScheduleAutoPauseNotice,
  workflowSchedulesQuery,
} from "@/components/cockpit/schedule-auto-pause";
import { ScheduleHistory } from "@/components/cockpit/schedule-history";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { MISSING } from "@/components/cockpit/table-columns";
import { WorkflowDraftingContext } from "@/components/cockpit/workflow-drafting-context";
import { WorkflowApprovals } from "@/components/cockpit/workflow-grants";
import { WorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";
import { WorkflowRuns } from "@/components/cockpit/workflow-runs";
import { WorkflowSpecCard } from "@/components/cockpit/workflow-spec-card";
import { StepSaveBar, useStepDraft } from "@/components/cockpit/workflow-step-editor";
import {
  type FlowTrigger,
  stepConnector,
  useBuildVersion,
  useWorkflowSteps,
  WorkflowFlow,
  WorkflowTestResult,
  WorkflowTestRun,
} from "@/components/cockpit/workflow-steps-list";
import { useCurrentVersionDag, WorkflowVersions } from "@/components/cockpit/workflow-versions";
import { definitionProductId } from "@/features/admin";
import {
  CurrentApprovalBody,
  CurrentApprovalPanel,
  currentApproval,
  durationBars,
  isLiveRun,
  openPairs,
  PairApprovalCard,
  PairLinkNotice,
  pairFailure,
  pairLinkId,
  pairLinkTarget,
  runTone,
  shownPair,
  stepRows,
  usePairApprovals,
  WorkflowHistoryPanel,
  WorkflowStepGraph,
  WorkflowStepsPanel,
} from "@/features/operations";
import { reportFailure } from "@/lib/action-failure";
import { cronWords } from "@/lib/cron-words";
import { formatDate, LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { ServiceIdentity } from "@/lib/service-icons";
import { statusLabel } from "@/lib/status-label";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { cn } from "@/lib/utils";
import { resultPhrase, type TriggerKind, triggerKindOf } from "@/lib/workflow-flow";
import { workflowPreviewDefinition } from "@/lib/workflow-preview";
import { removalConsequenceKeys } from "@/lib/workflow-removal";
import { definitionKind, type StepKindSource, stepWrites } from "@/lib/workflow-steps";
import { deletedConnectorReference } from "@/lib/workflow-strip";
import { workflowVersionAuthor } from "@/lib/workflow-versions";
import { formatRunDuration, runDisplayState, runDurationMs } from "@/pages/runs-model";
import { triggerLabelKey, withSection } from "@/pages/workflows-model";

type RecordValue = Record<string, unknown>;
type EffectiveTrigger = components["schemas"]["EffectiveTrigger"];
type ScheduleBinding = components["schemas"]["WorkflowScheduleBinding"];
type Execution = components["schemas"]["Execution"] & { held_effects?: boolean };

const text = (record: RecordValue, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

function useTechnicalFacts(record: RecordValue): Fact[] {
  const { t } = useI18n();
  const directory = useActorDirectory(true);
  const currentDag = useCurrentVersionDag(
    text(record, "id") ?? "",
    text(record, "current_version_id"),
    typeof record.current_version === "number" ? record.current_version : null,
  );
  const productId = definitionProductId(currentDag.data);
  const slug = text(record, "slug");
  const checksum = text(record, "checksum");
  const creator =
    record.creator && typeof record.creator === "object" ? (record.creator as RecordValue) : null;
  const actor =
    creator &&
    (creator.kind === "user" || creator.kind === "system_account") &&
    typeof creator.id === "string"
      ? ({ kind: creator.kind, id: creator.id } as const)
      : null;
  return [
    {
      label: t("resource.field.slug"),
      value: slug ? <span className="break-all font-mono text-xs">{slug}</span> : MISSING,
      testId: "workflow-technical-slug",
    },
    {
      label: t("catalog.version"),
      value: typeof record.current_version === "number" ? `v${record.current_version}` : MISSING,
      testId: "workflow-technical-version",
    },
    {
      label: t("workflowPage.checksum"),
      value: checksum ? <span className="break-all font-mono text-xs">{checksum}</span> : MISSING,
      testId: "workflow-technical-checksum",
    },
    {
      label: t("workflowPage.createdBy"),
      value: workflowVersionAuthor(actor, directory, t),
      testId: "workflow-technical-creator",
    },
    ...(productId
      ? [
          {
            label: t("workflowPage.app"),
            value: <span className="break-all font-mono text-xs">{productId}</span>,
            testId: "workflow-technical-app",
          },
        ]
      : []),
  ];
}

function useFlowTrigger(record: RecordValue): FlowTrigger {
  const { t, locale } = useI18n();
  const effective = (
    record.effective_trigger && typeof record.effective_trigger === "object"
      ? record.effective_trigger
      : { kind: "request", source: "default", state: "active" }
  ) as EffectiveTrigger;
  const schedule = (record.schedule ?? null) as ScheduleBinding;
  const kind: TriggerKind = triggerKindOf(effective);
  const label = t(triggerLabelKey(effective));
  const line =
    kind === "schedule"
      ? schedule?.cron
        ? cronWords(schedule.cron, t, LOCALE_TAGS[locale])
        : t("workflowFlow.trigger.scheduleLine")
      : kind === "webhook"
        ? t("workflowFlow.trigger.webhookLine")
        : t("workflowFlow.trigger.requestLine");
  return { kind, label, line };
}

function LastRunLine({
  workflowId,
  run,
  emptyAction,
}: {
  workflowId: string;
  run: Execution | null;
  emptyAction?: ReactNode;
}) {
  const { t, dateTime, locale } = useI18n();
  if (!run)
    return (
      <DataState
        state="empty"
        line={t("workflowFlow.lastRun.none")}
        action={emptyAction}
        testId="workflow-last-run-none"
      />
    );
  const displayState = runDisplayState(run.status, undefined, run.held_effects);
  const tone = displayState === "held" ? "warn" : statusTone(displayState);
  const duration = runDurationMs(run);
  const when = run.started_at ?? run.created_at;
  return (
    <a
      href={absolute(workflowSectionHref(workflowId, "history"))}
      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="workflow-last-run"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          tone === "neutral" ? "bg-muted-foreground/40" : STATUS_DOT[tone],
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          {t(
            displayState === "held"
              ? "workflowFlow.lastRun.held"
              : tone === "error"
                ? "workflowFlow.lastRun.failed"
                : tone === "ok"
                  ? "workflowFlow.lastRun.ok"
                  : "workflowFlow.lastRun.other",
          )}
        </span>{" "}
        <span className="text-muted-foreground">
          · {dateTime(when)}
          {duration === null ? "" : ` · ${formatRunDuration(locale, duration)}`}
        </span>
      </span>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {t("workflowFlow.lastRun.all")}
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

function connectorEnvironment(
  records: readonly { id: string }[],
  id: string | null | undefined,
): ConnectorEnvironment | null {
  const environment = (
    records.find((record) => record.id === id) as { environment?: unknown } | undefined
  )?.environment;
  return isConnectorEnvironment(environment) ? environment : null;
}

export function WorkflowPage({
  id,
  record,
  title,
  permissions,
}: {
  id: string;
  record: RecordValue;
  title: string;
  permissions: readonly string[];
}) {
  const { t, tn, dateTime, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"disable" | "delete" | null>(null);
  const [offersApproval, setOffersApproval] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const autoPaused = Boolean(
    useQuery(workflowSchedulesQuery(id)).data?.schedules.some((entry) => entry.auto_pause),
  );
  const canWrite = permissions.includes("workflow:write");
  const canRun = permissions.includes("workflow:run");
  const canChat = permissions.includes("conversation:write");
  const versionId = text(record, "current_version_id");
  const lastExecutedAt = text(record, "last_executed_at");
  const draftVersionId = text(record, "draft_version_id");
  const legacy = record.invalid === true;
  const version = typeof record.current_version === "number" ? record.current_version : null;
  const trigger =
    record.effective_trigger && typeof record.effective_trigger === "object"
      ? ((record.effective_trigger as { kind?: unknown }).kind ?? null)
      : null;
  const effectiveTrigger = typeof trigger === "string" ? trigger : null;
  const webhooksActive = typeof record.webhooks_active === "number" ? record.webhooks_active : 0;
  const stepRecords = Array.isArray(record.steps)
    ? record.steps.filter((step): step is RecordValue => Boolean(step) && typeof step === "object")
    : [];
  const workflow = {
    lifecycle: text(record, "lifecycle"),
    current_version_id: versionId,
    draft_version_id: draftVersionId,
    current_version: version,
    webhooks_active: webhooksActive,
    invalid: legacy,
  };
  const health = text(record, "health_state");
  const disabled = record.lifecycle === "archived";
  const versionIds = useMemo(
    () => ({ current: versionId, draft: draftVersionId }),
    [versionId, draftVersionId],
  );

  const automation = useWorkflowAutomation(id, workflow, permissions);
  const build = useBuildVersion(id, {
    ...workflow,
    steps: stepRecords,
    definition:
      record.definition && typeof record.definition === "object"
        ? (record.definition as RecordValue)
        : null,
  });
  const previewDefinition =
    !draftVersionId || draftVersionId === versionId || build.saved ? build.definition : null;
  const noSteps = !build.pending && build.steps.length === 0;
  const editor = useStepDraft(build.steps);
  const steps = useWorkflowSteps({
    workflowId: id,
    versionId: build.versionId,
    steps: editor.steps,
  });
  const connectorRecords = useConnectorRecords();
  const waitingForCredentials = useWaitingConnector(
    steps.views.map((view) => ({
      connectorId: view.definition.connectorId,
      connector: view.definition.connector,
    })),
  );
  const waitingConnector =
    deletedConnectorReference(record.connector_references) ?? waitingForCredentials;
  const technical = useTechnicalFacts(record);
  const session = useSession();
  const directory = useActorDirectory(true);
  const sideAvailable = useSideDetailsAvailable();
  const canReadRuns = permissions.includes("execution:read");
  const rows = stepRows(
    steps.views.map((view) => {
      const connector = stepConnector(view.definition, connectorRecords);
      const raw = view.definition.raw;
      const name = typeof raw.name === "string" && raw.name ? raw.name : null;
      return {
        id: view.definition.id,
        kind: view.definition.kind,
        name,
        connector: connector?.name ?? null,
        target: view.definition.essence.kind === "request" ? view.definition.essence.target : null,
        writes: stepWrites(view.definition),
        lastStatus: view.lastRun?.status ?? null,
      };
    }),
  );
  const authorityList = useQuery({
    queryKey: ["workflow-authorities", id, "newest"],
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/execution-authorities", {
        path: { id },
        query: { limit: 20 },
      }),
  });
  const approval = currentApproval(authorityList.data?.items ?? null);
  const pairs = usePairApprovals(id, permissions.includes("workflow:read"));
  const search = useRouterState({ select: (router) => router.location.searchStr });
  const [actedOn, setActedOn] = useState<string | null>(null);
  const linkedId = pairLinkId(search);
  const pairLink = pairLinkTarget(
    linkedId,
    pairs.loading || pairs.failed ? null : pairs.items,
    automation.now,
    actedOn,
  );
  const openPair = shownPair(pairLink, openPairs(pairs.items, automation.now)[0] ?? null);
  const hash = useRouterState({ select: (router) => router.location.hash });
  const requested = workflowSectionFromHash(hash);
  const [sections, setSections] = useState<ReadonlySet<WorkflowSection>>(
    () => new Set(requested ? [requested] : []),
  );
  const reveal = useCallback((section: WorkflowSection) => {
    setSections((open) => withSection(open, section, true));
    requestAnimationFrame(() =>
      document
        .getElementById(workflowSectionAnchor(section))
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }, []);
  useEffect(() => {
    if (requested) reveal(requested);
  }, [requested, reveal]);
  const showDetails = useShowSideDetails();
  const revealed = useRef<string | null>(null);
  const revealId = pairLink.kind === "none" ? null : linkedId;
  useEffect(() => {
    if (!revealId || revealed.current === revealId) return;
    revealed.current = revealId;
    showDetails?.();
  }, [revealId, showDetails]);
  const recent = useQuery({
    queryKey: ["workflow", id, "recent-runs"],
    enabled: canReadRuns,
    queryFn: () => apiCall("get", "/v1/executions", { query: { workflow_id: id, limit: 12 } }),
  });
  const recentRuns = recent.data?.items ?? [];
  const flowTrigger = useFlowTrigger(record);
  const result = resultPhrase(record.output_schema);
  const lifecycle = useOptimisticAction({
    queryKey: ["catalog-detail", "workflows", id],
    mutationFn: (next: "active" | "archived") =>
      apiCall("patch", "/v1/workflows/{id}/metadata", {
        path: { id },
        body: { lifecycle: next },
      }),
    apply: (current: RecordValue | undefined, next) =>
      current ? { ...current, lifecycle: next } : current,
    onSuccess: (_result, next) => {
      toast.success(
        t(next === "archived" ? "workflowPage.disabled" : "workflowPage.enabled", { name: title }),
      );
      setConfirming(null);
      automation.refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiCall("delete", "/v1/workflows/{id}", { path: { id } }),

    onSuccess: async () => {
      toast.success(t("workflowPage.deleted", { name: title }));
      setConfirming(null);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      void navigate({ to: "/workflows" });
    },
    onError: (failure) => reportFailure(t("common.actionFailed"), failure),
  });

  const metadataActions = useCatalogMetadataActions({
    kind: "workflow",
    id,
    record,
    queryKey: ["catalog-detail", "workflows", id],
    onEdit: () => setEditing(true),
  }).filter((item) => item.testId !== "catalog-metadata-edit");

  const menu: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("workflowPage.changeInChat"),
            href: absolute(chatNewHref({ workflowId: id, references: [{ type: "workflow", id }] })),
            testId: "workflow-menu-ask",
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: t("workflowPage.edit"),
            onSelect: () => setEditing(true),
            testId: "workflow-menu-edit",
          },
          ...metadataActions,
          disabled
            ? {
                label: t("workflowStrip.action.enable"),
                onSelect: () => lifecycle.mutate("active"),
                testId: "workflow-menu-enable",
              }
            : {
                label: t("workflowPage.disable"),
                onSelect: () => setConfirming("disable"),
                testId: "workflow-menu-disable",
              },
          {
            label: t("workflowPage.delete"),
            onSelect: () => setConfirming("delete"),
            destructive: true,
            testId: "workflow-menu-delete",
          },
        ]
      : []),
  ];

  const state = automation.state;
  const kinds = [
    ...((state?.triggers.some((entry) => entry.kind === "hook") ?? false) || webhooksActive > 0
      ? [t("invocation.mode.webhook")]
      : []),
    ...(state?.triggers.some((entry) => entry.kind === "schedule" && !entry.paused)
      ? [t("invocation.mode.schedule")]
      : []),
  ];
  const starters = {
    webhook:
      (state?.triggers.some((entry) => entry.kind === "hook") ?? false) || webhooksActive > 0,
    schedule: state?.triggers.some((entry) => entry.kind === "schedule") ?? false,
  };
  const consequence = (removal: "delete" | "disable") =>
    removalConsequenceKeys(removal, starters)
      .map((key) => t(key))
      .join(" ");
  const useSummary = state ? (
    kinds.length > 0 ? (
      <span data-testid="workflow-automation-triggers">
        {t("workflowPage.calledBy", { kinds: kinds.join(t("workflowPage.and")) })}
      </span>
    ) : (
      t("workflowPage.calledOnRequest")
    )
  ) : null;
  const services = new Map<
    string,
    {
      label: string;
      href: string | null;
      service: ServiceIdentity;
      environment: ConnectorEnvironment | null;
    }
  >();
  const activeStepKinds = new Map<string, StepKindSource>();
  for (const view of steps.views) {
    const connector = stepConnector(view.definition, connectorRecords);
    activeStepKinds.set(
      view.definition.id,
      definitionKind(view.definition, connector?.service ?? null),
    );
    if (!connector?.name || services.has(connector.name)) continue;
    services.set(connector.name, {
      label: connector.name,
      href: connector.id ? absolute(connectorHref(connector.id)) : null,
      service: connector.service,
      environment: connectorEnvironment(connectorRecords, connector.id),
    });
  }
  const overviewSummary = (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {[
        flowTrigger.kind === "schedule"
          ? `${flowTrigger.label} · ${flowTrigger.line}`
          : flowTrigger.label,
        build.pending ? null : tn("workflowPage.steps", steps.views.length),
        services.size === 0 ? t("workflowFlow.noServices") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      {[...services.values()].map((entry, index) => (
        <span key={entry.label} className="inline-flex items-center gap-1">
          {entry.href ? (
            <a
              href={entry.href}
              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-foreground underline-offset-4 hover:underline"
              data-testid={`workflow-build-connector-${index}`}
            >
              <ServiceIcon service={entry.service} className="size-3.5" />
              {entry.label}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
              <ServiceIcon service={entry.service} className="size-3.5" />
              {entry.label}
            </span>
          )}
          {entry.environment ? (
            <EnvironmentChip
              environment={entry.environment}
              testId={`workflow-build-connector-${index}-environment`}
            />
          ) : null}
        </span>
      ))}
    </span>
  );

  const runDisabledReason = !canRun
    ? t("run.unavailable.permission")
    : legacy
      ? t("run.unavailable.invalid")
      : disabled
        ? t("run.unavailable.disabled")
        : stepRecords.length === 0
          ? t("run.unavailable.empty")
          : undefined;
  const runProps = {
    quiet: editor.dirty,
    disabled: Boolean(runDisabledReason),
    disabledReason: runDisabledReason,
    approvedVersion: version,
    workflowId: id,
    workflowName: title,
    liveEnvironment: automation.runEnvironment,
  };
  const canPreview =
    canRun && Boolean(previewDefinition) && previewDefinition?.execution_privacy !== "sensitive";
  const category = recordCategory(record);

  const approvalBody = (
    <CurrentApprovalBody
      rows={
        approval
          ? [
              {
                label: t("ops.wf.environment"),
                value: t(
                  approval.environment === "prod"
                    ? "authority.production"
                    : "authority.development",
                ),
              },
              {
                label: t("authority.limit.label"),
                value: approval.validUntil
                  ? t("ops.run.validUntil", { date: formatDate(locale, approval.validUntil) })
                  : t("authority.limit.untilRevoked"),
              },
              {
                label: t("ops.wf.approvedBy"),
                value: workflowVersionAuthor(
                  { kind: "user", id: approval.createdBy },
                  directory,
                  t,
                ),
              },
              { label: t("ops.run.approvedAt"), value: dateTime(approval.createdAt) },
            ]
          : null
      }
      used={
        approval
          ? approval.maxRuns === null
            ? tn("ops.wf.runsUsedOpen", approval.used)
            : t("ops.wf.runsUsed", { used: approval.used, max: approval.maxRuns })
          : null
      }
    >
      <PairLinkNotice target={pairLink} />
      {openPair ? (
        <PairApprovalCard
          key={openPair.id}
          pair={openPair}
          viewerId={session.principal.id}
          now={automation.now}
          pending={pairs.pending}
          failure={pairFailure(pairs.error)}
          linked={pairLink.kind === "open" && pairLink.pair.id === openPair.id}
          onAction={(action) => {
            setActedOn(openPair.id);
            pairs.act(openPair.id, action);
          }}
        />
      ) : null}
      <a
        href={absolute(workflowSectionHref(id, "approvals"))}
        className="text-sm font-medium underline underline-offset-4"
        data-testid="workflow-approval-manage"
      >
        {t("ops.wf.manage")}
      </a>
    </CurrentApprovalBody>
  );

  const sectionProps = (section: WorkflowSection, label: string) => ({
    label,
    id: workflowSectionAnchor(section),
    open: sections.has(section),
    onOpenChange: (next: boolean) => setSections((open) => withSection(open, section, next)),
    testId: `workflow-section-${section}`,
  });

  const tabs: PageTab[] = [
    {
      value: "overview",
      label: t("workflowPage.tab.overview"),
      content: (
        <div className="flex flex-col gap-8" data-testid="workflow-overview">
          <div className="@container">
            <div className="grid gap-4 @xl:grid-cols-2">
              <WorkflowStepsPanel
                rows={rows}
                action={
                  canWrite && !legacy ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => reveal("build")}
                      data-testid="workflow-steps-edit"
                    >
                      {t("ops.wf.editSteps")}
                    </Button>
                  ) : undefined
                }
              />
              <div className="flex flex-col gap-4">
                {sideAvailable ? null : <CurrentApprovalPanel>{approvalBody}</CurrentApprovalPanel>}
                {canReadRuns ? (
                  <WorkflowHistoryPanel
                    durations={durationBars(recentRuns)}
                    more={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => reveal("history")}
                        data-testid="workflow-history-all"
                      >
                        {t("runs.all")}
                      </Button>
                    }
                    runs={recentRuns.map((run) => ({
                      id: run.id,
                      tone: runTone(run.status),
                      pulse: isLiveRun(run.status),
                      label: statusLabel(t, run.status),
                      time: dateTime(run.started_at ?? run.created_at),
                      href: absolute(runHref(run.id)),
                    }))}
                  />
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <CollapsibleSection {...sectionProps("build", t("ops.wf.tab.build"))}>
              <TabBody
                testId="workflow-build"
                summary={
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1" data-testid="workflow-build-summary">
                      {overviewSummary}
                    </span>
                    {canRun && previewDefinition && (build.saved || editor.dirty) ? (
                      <WorkflowTestRun
                        steps={steps}
                        definition={workflowPreviewDefinition(
                          previewDefinition,
                          editor.steps as RecordValue[],
                        )}
                      />
                    ) : null}
                  </div>
                }
                more={
                  <>
                    {build.definition ? (
                      <CollapsibleSection
                        label={t("workflowFlow.definition")}
                        testId="workflow-definition-section"
                      >
                        <CodeBlock
                          label={t("workflowFlow.definition")}
                          code={JSON.stringify(build.definition, null, 2)}
                          lang="json"
                          testId="workflow-technical-definition"
                        />
                      </CollapsibleSection>
                    ) : null}
                    <WorkflowVersions
                      workflowId={id}
                      workflowName={title}
                      ids={versionIds}
                      access={{
                        canRestore: permissions.includes("workflow:restore"),
                        archived: disabled,
                      }}
                      onRestored={automation.refresh}
                    />
                    {permissions.includes("skill:read") ? (
                      <WorkflowDraftingContext
                        workflowId={id}
                        activeVersionId={versionId}
                        activeSteps={activeStepKinds}
                      />
                    ) : null}
                  </>
                }
              >
                {permissions.includes("workflow:read") ? (
                  <WorkflowSpecCard
                    workflowId={id}
                    draftVersionId={draftVersionId}
                    canWrite={canWrite}
                  />
                ) : null}
                <WorkflowTestResult steps={steps} visible={build.saved || editor.dirty} />
                <WorkflowFlow
                  key={`${id}:${build.versionId ?? "none"}`}
                  steps={steps}
                  trigger={flowTrigger}
                  result={t(result.key, result.values)}
                  workflowName={title}
                  canRun={canPreview}
                  {...(canWrite && !legacy ? { editor } : {})}
                />
                {canWrite ? <StepSaveBar workflowId={id} record={record} draft={editor} /> : null}
                {permissions.includes("execution:read") ? (
                  <LastRunLine
                    workflowId={id}
                    run={steps.lastRun}
                    emptyAction={
                      <RunWorkflowDialog
                        {...runProps}
                        quiet
                        triggerLabel={t("workflow.testRun")}
                        triggerTestId="workflow-last-run-start"
                      />
                    }
                  />
                ) : null}
              </TabBody>
            </CollapsibleSection>
            <CollapsibleSection {...sectionProps("use", t("workflowPage.tab.use"))}>
              <TabBody
                testId="workflow-use"
                summary={useSummary ?? undefined}
                more={
                  <>
                    <CollapsibleSection label={t("workflowPage.io")} testId="workflow-io-section">
                      <WorkflowInputOutput
                        workflowId={id}
                        byWebhook={effectiveTrigger === "webhook" || webhooksActive > 0}
                        draftDefinition={versionId ? null : build.definition}
                      />
                    </CollapsibleSection>
                    {permissions.includes("conversation:read") ? (
                      <ConversationsAbout target={{ workflow_id: id }} />
                    ) : null}
                  </>
                }
              >
                <WorkflowInvocation
                  workflowId={id}
                  workflowName={title}
                  canWrite={canWrite}
                  canChat={canChat}
                  approvedEnvironment={state?.state === "approved" ? state.environment : null}
                />
              </TabBody>
            </CollapsibleSection>
            {canReadRuns ? (
              <CollapsibleSection {...sectionProps("history", t("runs.all"))}>
                <WorkflowRuns
                  workflowId={id}
                  emptyAction={
                    <RunWorkflowDialog
                      {...runProps}
                      quiet
                      triggerLabel={t("workflowRuns.runNow")}
                      triggerTestId="workflow-runs-run"
                    />
                  }
                />
              </CollapsibleSection>
            ) : null}
            <CollapsibleSection {...sectionProps("approvals", t("workflowPage.tab.approvals"))}>
              <WorkflowApprovals automation={automation} offersApproval={offersApproval} />
            </CollapsibleSection>
          </div>
        </div>
      ),
    },
    ...(permissions.includes("execution:read")
      ? [
          {
            value: "schedule",
            label: t("workflowPage.tab.schedule"),
            content: (
              <ScheduleHistory
                subject={{ kind: "workflow", id }}
                scheduled={effectiveTrigger === "schedule"}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <DetailPage
      testId="detail-workflows"
      back={{ to: "/workflows", label: t("nav.workflows") }}
      title={title}
      badge={<CatalogCategoryChip category={category} testId="catalog-metadata-chip" />}
      purpose={<CatalogPurpose record={record} />}
      menu={menu.length > 0 ? <ActionMenu items={menu} testId="workflow-menu" /> : undefined}
      action={<RunWorkflowDialog {...runProps} openOnAnchor={WORKFLOW_RUN_ANCHOR} />}
      technical={<FactList items={technical} testId="workflow-technical-facts" />}
      tabs={tabs}
      notice={<WorkflowStepGraph rows={rows} />}
      status={
        <>
          <ScheduleAutoPauseNotice workflowId={id} canWrite={canWrite} />
          <WorkflowStatus
            automation={automation}
            workflow={workflow}
            workflowName={title}
            health={health}
            disabled={disabled}
            lastRun={
              steps.lastRun ??
              (lastExecutedAt
                ? { status: "unknown", started_at: lastExecutedAt, created_at: lastExecutedAt }
                : null)
            }
            waitingConnector={waitingConnector}
            autoPaused={autoPaused}
            permissions={permissions}
            noSteps={noSteps}
            onOffersApproval={setOffersApproval}
            onAddStep={canWrite && !legacy ? () => reveal("build") : undefined}
          />
        </>
      }
    >
      {sideAvailable ? (
        <SideDetails>
          <SideSection first title={t("ops.wf.current")} testId="side-workflow-approval">
            {approvalBody}
          </SideSection>
        </SideDetails>
      ) : null}
      {canWrite ? (
        <MetadataDialog id={id} record={record} open={editing} onOpenChange={setEditing} />
      ) : null}
      <ConfirmDialog
        open={confirming === "disable"}
        onOpenChange={(next) => !next && setConfirming(null)}
        object={title}
        verb={t("workflowPage.disable")}
        consequence={consequence("disable")}
        pending={lifecycle.isPending}
        onConfirm={async () => {
          await lifecycle.mutateAsync("archived").catch(() => undefined);
        }}
        testId="workflow-disable-confirm"
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(next) => !next && setConfirming(null)}
        object={title}
        verb={t("workflowPage.delete")}
        consequence={consequence("delete")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync().catch(() => undefined);
        }}
        testId="workflow-delete-confirm"
      />
    </DetailPage>
  );
}
