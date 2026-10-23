import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useActorDirectory } from "@/app/actor-directory";
import {
  absolute,
  chatNewHref,
  connectorHref,
  WORKFLOW_RUN_ANCHOR,
  workflowHref,
} from "@/app/links";
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
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import {
  ActionMenu,
  type ActionMenuItem,
  CodeBlock,
  CollapsibleSection,
  ConfirmDialog,
  DataState,
  DetailPage,
  type Fact,
  FactList,
  type PageTab,
  STATUS_DOT,
  statusTone,
  TabBody,
} from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { ServiceIcon } from "@/components/cockpit/service-icon";
import { MISSING } from "@/components/cockpit/table-columns";
import { WorkflowDraftingContext } from "@/components/cockpit/workflow-drafting-context";
import { WorkflowApprovals } from "@/components/cockpit/workflow-grants";
import { WorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";
import { WorkflowRuns } from "@/components/cockpit/workflow-runs";
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
import { cronWords } from "@/lib/cron-words";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { ServiceIdentity } from "@/lib/service-icons";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { cn } from "@/lib/utils";
import { resultPhrase, type TriggerKind, triggerKindOf } from "@/lib/workflow-flow";
import { workflowPreviewDefinition } from "@/lib/workflow-preview";
import { removalConsequenceKeys } from "@/lib/workflow-removal";
import { definitionKind, type StepKindSource } from "@/lib/workflow-steps";
import { deletedConnectorReference } from "@/lib/workflow-strip";
import { workflowVersionAuthor } from "@/lib/workflow-versions";
import { definitionProductId } from "@/pages/apps-model";
import { formatRunDuration, runDurationMs } from "@/pages/runs-model";
import { triggerLabelKey } from "@/pages/workflows-model";

type RecordValue = Record<string, unknown>;
type EffectiveTrigger = components["schemas"]["EffectiveTrigger"];
type ScheduleBinding = components["schemas"]["WorkflowScheduleBinding"];
type Execution = components["schemas"]["Execution"];

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
  const tone = statusTone(run.status);
  const duration = runDurationMs(run);
  const when = run.started_at ?? run.created_at;
  return (
    <a
      href={absolute(`${workflowHref(workflowId)}?tab=history`)}
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
            tone === "error"
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
  const { t, tn } = useI18n();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"disable" | "delete" | null>(null);
  const [offersApproval, setOffersApproval] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
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
  const flowTrigger = useFlowTrigger(record);
  const result = resultPhrase(record.output_schema);
  const lifecycle = useOptimisticAction({
    queryKey: ["catalog-detail", "workflows", id],
    mutationFn: (next: "active" | "archived") =>
      apiRequest(`/v1/workflows/${encodeURIComponent(id)}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ lifecycle: next }),
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
    mutationFn: () => apiRequest(`/v1/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success(t("workflowPage.deleted", { name: title }));
      setConfirming(null);
      await client.invalidateQueries({ queryKey: ["catalog"] });
      void navigate({ to: "/workflows" });
    },
    onError: () => toast.error(t("common.actionFailed")),
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
    { label: string; href: string | null; service: ServiceIdentity }
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
          {index === 0 ? "· " : null}
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

  const tabs: PageTab[] = [
    {
      value: "overview",
      label: t("workflowPage.tab.overview"),
      content: (
        <TabBody
          testId="workflow-overview"
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
          technical={
            <>
              <FactList items={technical} testId="workflow-technical-facts" />
              {build.definition ? (
                <CodeBlock
                  label={t("workflowFlow.definition")}
                  code={JSON.stringify(build.definition, null, 2)}
                  lang="json"
                  testId="workflow-technical-definition"
                />
              ) : null}
            </>
          }
        >
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
      ),
    },
    {
      value: "use",
      label: t("workflowPage.tab.use"),
      content: (
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
      ),
    },
    ...(permissions.includes("execution:read")
      ? [
          {
            value: "history",
            label: t("workflowPage.tab.history"),
            content: (
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
            ),
          },
        ]
      : []),
    {
      value: "approvals",
      label: t("workflowPage.tab.approvals"),
      content: <WorkflowApprovals automation={automation} offersApproval={offersApproval} />,
    },
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
      tabs={tabs}
      status={
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
          permissions={permissions}
          noSteps={noSteps}
          onOffersApproval={setOffersApproval}
        />
      }
    >
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
