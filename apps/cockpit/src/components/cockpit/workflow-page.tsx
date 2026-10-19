import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { absolute, chatNewHref, connectorHref } from "@/app/links";
import {
  useWaitingConnector,
  useWorkflowAutomation,
  WorkflowStatus,
} from "@/components/cockpit/automation-panel";
import {
  CatalogMetadataDialog,
  CatalogMetadataSummary,
  useCatalogMetadataActions,
} from "@/components/cockpit/catalog-metadata";
import { useConnectorRecords } from "@/components/cockpit/connector-names";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import {
  ActionButton,
  ActionMenu,
  type ActionMenuItem,
  CollapsibleSection,
  ConfirmDialog,
  type Fact,
  FactList,
  Page,
  PageHeader,
  type PageTab,
  PageTabs,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { MISSING } from "@/components/cockpit/table-columns";
import { WorkflowDraftingContext } from "@/components/cockpit/workflow-drafting-context";
import { WorkflowApprovals } from "@/components/cockpit/workflow-grants";
import { WorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";
import { WorkflowRuns } from "@/components/cockpit/workflow-runs";
import {
  StepDialog,
  StepSaveBar,
  stepId,
  useStepDraft,
} from "@/components/cockpit/workflow-step-editor";
import {
  useBuildVersion,
  useWorkflowSteps,
  WorkflowStepsList,
  WorkflowTestResult,
  WorkflowTestRun,
} from "@/components/cockpit/workflow-steps-list";
import { useCurrentVersionDag, WorkflowVersions } from "@/components/cockpit/workflow-versions";
import { useI18n } from "@/lib/i18n-context";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { workflowPreviewDefinition } from "@/lib/workflow-preview";
import { removalConsequenceKeys } from "@/lib/workflow-removal";
import { deletedConnectorReference } from "@/lib/workflow-strip";
import { workflowVersionAuthor } from "@/lib/workflow-versions";
import { definitionProductId } from "@/pages/apps-model";

type RecordValue = Record<string, unknown>;

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
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<"disable" | "delete" | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const canWrite = permissions.includes("workflow:write");
  const canRun = permissions.includes("workflow:run");
  const canChat = permissions.includes("conversation:write");
  const versionId = text(record, "current_version_id");
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
    onEdit: () => setDescribing(true),
  });

  const menu: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("catalog.conversations.ask"),
            href: absolute(chatNewHref({ workflowId: id, references: [{ type: "workflow", id }] })),
            testId: "workflow-menu-ask",
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: t("detail.editMetadata"),
            onSelect: () => setRenaming(true),
            testId: "workflow-menu-rename",
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
  const connectors = new Map<string, { label: string; href: string | null }>();
  for (const view of steps.views) {
    const { connector, connectorId } = view.definition;
    const known = connectorRecords.find((item) =>
      connectorId ? item.id === connectorId : item.slug === connector,
    );
    const label = known?.display_name ?? connector;
    if (!label || connectors.has(label)) continue;
    const id = known?.id ?? connectorId ?? null;
    connectors.set(label, { label, href: id ? absolute(connectorHref(id)) : null });
  }
  const buildSummary = (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {[
        build.version === null
          ? null
          : t("automation.fact.version", { version: `v${build.version}` }),
        build.pending
          ? null
          : t(steps.views.length === 1 ? "workflowPage.steps.one" : "workflowPage.steps.other", {
              count: steps.views.length,
            }),
      ]
        .filter(Boolean)
        .join(" · ")}
      {[...connectors.values()].map((entry, index) =>
        entry.href ? (
          <a
            key={entry.label}
            href={entry.href}
            className="rounded-md border px-1.5 py-0.5 text-xs text-foreground underline-offset-4 hover:underline"
            data-testid={`workflow-build-connector-${index}`}
          >
            {entry.label}
          </a>
        ) : (
          <span key={entry.label} className="rounded-md border px-1.5 py-0.5 text-xs">
            {entry.label}
          </span>
        ),
      )}
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

  const tabs: PageTab[] = [
    {
      value: "use",
      label: t("workflowPage.tab.use"),
      content: (
        <>
          {useSummary ? <SummaryLine text={useSummary} testId="workflow-use-summary" /> : null}
          <WorkflowInvocation
            workflowId={id}
            workflowName={title}
            canWrite={canWrite}
            canChat={canChat}
            effectiveTrigger={effectiveTrigger}
            approvedEnvironment={state?.state === "approved" ? state.environment : null}
          />
          <CollapsibleSection label={t("workflowPage.io")} testId="workflow-io-section">
            <WorkflowInputOutput
              workflowId={id}
              byWebhook={effectiveTrigger === "webhook" || webhooksActive > 0}
              draftDefinition={versionId ? null : build.definition}
            />
          </CollapsibleSection>
        </>
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
      value: "structure",
      label: t("workflowPage.tab.build"),
      content: (
        <>
          {steps.views.length > 0 ? (
            <SummaryLine
              text={buildSummary}
              aside={
                canWrite && !legacy && editor.steps.length > 0 ? (
                  <ActionButton size="sm" onClick={() => setAdding(true)} testId="step-add">
                    {t("stepEditor.addTitle")}
                  </ActionButton>
                ) : undefined
              }
              testId="workflow-build-summary"
            />
          ) : null}
          <WorkflowTestResult steps={steps} dirty={editor.dirty} />
          <WorkflowStepsList
            key={`${id}:${build.versionId ?? "none"}`}
            steps={steps}
            workflowName={title}
            canRun={
              canRun &&
              Boolean(previewDefinition) &&
              previewDefinition?.execution_privacy !== "sensitive"
            }
            {...(canWrite && !legacy
              ? {
                  editor,
                  emptyAction: (
                    <ActionButton size="sm" onClick={() => setAdding(true)} testId="step-add">
                      {t("stepEditor.addTitle")}
                    </ActionButton>
                  ),
                }
              : {})}
          />
          {canWrite ? (
            <StepSaveBar
              workflowId={id}
              record={record}
              draft={editor}
              preview={
                canRun && previewDefinition && steps.views.length > 0 ? (
                  <WorkflowTestRun
                    steps={steps}
                    definition={workflowPreviewDefinition(
                      previewDefinition,
                      editor.steps as RecordValue[],
                    )}
                  />
                ) : undefined
              }
            />
          ) : null}
          <div className="flex flex-col gap-2">
            <WorkflowVersions
              workflowId={id}
              workflowName={title}
              ids={versionIds}
              access={{ canRestore: permissions.includes("workflow:restore"), archived: disabled }}
              onRestored={automation.refresh}
            />
            <CollapsibleSection
              label={t("connectorDetail.technical.title")}
              testId="workflow-technical"
            >
              <FactList items={technical} />
            </CollapsibleSection>
            {permissions.includes("skill:read") ? (
              <WorkflowDraftingContext workflowId={id} activeVersionId={versionId} />
            ) : null}
            {permissions.includes("conversation:read") ? (
              <ConversationsAbout target={{ workflow_id: id }} />
            ) : null}
          </div>
        </>
      ),
    },
    {
      value: "approvals",
      label: t("workflowPage.tab.approvals"),
      content: <WorkflowApprovals automation={automation} />,
    },
  ];

  return (
    <Page
      kind="detail"
      scroll="page"
      testId="detail-workflows"
      surface="detail"
      header={
        <PageHeader
          back={{ to: "/workflows", label: t("nav.workflows") }}
          title={title}
          purpose={<CatalogMetadataSummary record={record} />}
          menu={menu.length > 0 ? <ActionMenu items={menu} testId="workflow-menu" /> : undefined}
          action={<RunWorkflowDialog {...runProps} />}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <WorkflowStatus
          automation={automation}
          workflow={workflow}
          workflowName={title}
          health={health}
          disabled={disabled}
          lastRunAt={text(record, "last_executed_at")}
          waitingConnector={waitingConnector}
          permissions={permissions}
          noSteps={noSteps}
        />
        <PageTabs tabs={tabs} param="tab" testId="workflow-tabs" />
      </div>
      {canWrite ? (
        <MetadataDialog id={id} title={title} open={renaming} onOpenChange={setRenaming} />
      ) : null}
      {canWrite ? (
        <StepDialog
          open={adding}
          onOpenChange={setAdding}
          step={null}
          taken={editor.steps.map(stepId)}
          onApply={editor.add}
        />
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
      {canWrite ? (
        <CatalogMetadataDialog
          kind="workflow"
          id={id}
          record={record}
          open={describing}
          onOpenChange={setDescribing}
          queryKey={["catalog-detail", "workflows", id]}
        />
      ) : null}
    </Page>
  );
}
