import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { absolute, chatNewHref } from "@/app/links";
import {
  useWaitingConnector,
  useWorkflowAutomation,
  WorkflowStatus,
} from "@/components/cockpit/automation-panel";
import { useConnectorNames } from "@/components/cockpit/connector-names";
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
  useWorkflowSteps,
  WorkflowStepsList,
  WorkflowTestResult,
  WorkflowTestRun,
} from "@/components/cockpit/workflow-steps-list";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { useOptimisticAction } from "@/lib/use-optimistic-action";
import { connectorNameOf } from "@/lib/workflow-steps";
import { WorkflowRecategorize } from "@/pages/catalog";

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

function draftDefinition(record: RecordValue, steps: readonly RecordValue[]): RecordValue {
  return {
    name: text(record, "name") ?? "Preview",
    ...(text(record, "slug") ? { slug: record.slug } : {}),
    ...(text(record, "description") ? { description: record.description } : {}),
    steps,
  };
}

function useTechnicalFacts(record: RecordValue): Fact[] {
  const { t, dateTime } = useI18n();
  const slug = text(record, "slug");
  const lifecycle = text(record, "lifecycle");
  const created = text(record, "created_at");
  const updated = text(record, "updated_at");
  const lastRun = text(record, "last_executed_at");
  const version = record.current_version;
  return [
    {
      label: t("resource.field.slug"),
      value: slug ? <span className="break-all font-mono text-xs">{slug}</span> : MISSING,
      testId: "workflow-technical-slug",
    },
    {
      label: t("catalog.version"),
      value: typeof version === "number" ? `v${version}` : MISSING,
      testId: "workflow-technical-version",
    },
    {
      label: t("catalog.lifecycle"),
      value: lifecycle ? statusLabel(t, lifecycle) : MISSING,
      testId: "workflow-technical-lifecycle",
    },
    {
      label: t("resource.field.createdAt"),
      value: created ? dateTime(created) : MISSING,
      testId: "workflow-technical-created",
    },
    {
      label: t("catalog.updated"),
      value: updated ? dateTime(updated) : MISSING,
      testId: "workflow-technical-updated",
    },
    {
      label: t("catalog.lastRun"),
      value: lastRun ? dateTime(lastRun) : MISSING,
      testId: "workflow-technical-last-run",
    },
  ];
}

export function WorkflowPage({
  id,
  record,
  title,
  purpose,
  permissions,
}: {
  id: string;
  record: RecordValue;
  title: string;
  purpose: string | null;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<"disable" | "delete" | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const canWrite = permissions.includes("workflow:write");
  const canRun = permissions.includes("workflow:run");
  const canChat = permissions.includes("conversation:write");
  const versionId = text(record, "current_version_id");
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
    draft_version_id: text(record, "draft_version_id"),
    current_version: version,
    webhooks_active: webhooksActive,
    invalid: legacy,
  };
  const health = text(record, "health_state");
  const disabled = record.lifecycle === "archived";

  const automation = useWorkflowAutomation(id, workflow, permissions);
  const editor = useStepDraft(stepRecords);
  const steps = useWorkflowSteps({ workflowId: id, versionId, steps: editor.steps });
  const connectorNames = useConnectorNames();
  const waitingConnector = useWaitingConnector(
    steps.views.map((view) => ({
      connectorId: view.definition.connectorId,
      connector: view.definition.connector,
    })),
  );
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

  const menu: ActionMenuItem[] = [
    ...(canChat
      ? [
          {
            label: t("workflowPage.ask"),
            href: absolute(
              chatNewHref({ workflowId: id, prompt: t("workflowPage.askPrompt", { name: title }) }),
            ),
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
          {
            label: t("catalog.changeCategory"),
            onSelect: () => setMoving(true),
            testId: "workflow-menu-category",
          },
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
  const useSummary = state ? (
    kinds.length > 0 ? (
      <span data-testid="workflow-automation-triggers">
        {t("workflowPage.calledBy", { kinds: kinds.join(t("workflowPage.and")) })}
      </span>
    ) : (
      t("workflowPage.calledOnRequest")
    )
  ) : null;
  const connectors = [
    ...new Set(
      steps.views
        .map((view) => connectorNameOf(view.definition, connectorNames))
        .filter((name): name is string => Boolean(name)),
    ),
  ];
  const buildSummary = [
    version === null ? null : t("automation.fact.version", { version: `v${version}` }),
    t(steps.views.length === 1 ? "workflowPage.steps.one" : "workflowPage.steps.other", {
      count: steps.views.length,
    }),
    connectors.length > 0 ? connectors.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: PageTab[] = [
    {
      value: "verwenden",
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
            />
          </CollapsibleSection>
        </>
      ),
    },
    ...(permissions.includes("execution:read")
      ? [
          {
            value: "verlauf",
            label: t("workflowPage.tab.history"),
            content: <WorkflowRuns workflowId={id} />,
          },
        ]
      : []),
    {
      value: "aufbau",
      label: t("workflowPage.tab.build"),
      content: (
        <>
          <SummaryLine
            text={buildSummary}
            help={canRun && steps.views.length > 0 ? t("workflow.testRunSecondary") : undefined}
            aside={
              <>
                {canRun && steps.views.length > 0 ? (
                  <WorkflowTestRun
                    steps={steps}
                    definition={draftDefinition(record, editor.steps as RecordValue[])}
                  />
                ) : null}
                {canWrite && !legacy && editor.steps.length > 0 ? (
                  <ActionButton size="sm" onClick={() => setAdding(true)} testId="step-add">
                    {t("stepEditor.addTitle")}
                  </ActionButton>
                ) : null}
              </>
            }
            testId="workflow-build-summary"
          />
          <WorkflowTestResult steps={steps} />
          <WorkflowStepsList
            key={`${id}:${versionId ?? "none"}`}
            steps={steps}
            canRun={canRun}
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
          {canWrite ? <StepSaveBar workflowId={id} record={record} draft={editor} /> : null}
          <div className="flex flex-col gap-2">
            <CollapsibleSection
              label={t("connectorDetail.technical.title")}
              testId="workflow-technical"
            >
              <FactList items={technical} />
            </CollapsibleSection>
            {permissions.includes("conversation:read") ? (
              <ConversationsAbout target={{ workflow_id: id }} />
            ) : null}
          </div>
        </>
      ),
    },
    {
      value: "freigaben",
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
          purpose={purpose || undefined}
          secondary={
            canChat ? (
              <ActionMenu
                items={[
                  {
                    label: t("detail.changeInChat"),
                    href: absolute(
                      chatNewHref({
                        workflowId: id,
                        prompt: t("detail.changePrompt", { name: title }),
                      }),
                    ),
                    testId: "workflow-menu-change",
                  },
                ]}
              />
            ) : undefined
          }
          menu={menu.length > 0 ? <ActionMenu items={menu} testId="workflow-menu" /> : undefined}
          action={
            canRun && !legacy && !disabled ? (
              <RunWorkflowDialog
                workflowId={id}
                workflowName={title}
                version={version === null ? null : String(version)}
                versionId={versionId}
              />
            ) : undefined
          }
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
        consequence={t("workflowPage.disableConsequence")}
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
        consequence={t("workflowPage.deleteConsequence")}
        destructive
        pending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync().catch(() => undefined);
        }}
        testId="workflow-delete-confirm"
      />
      {canWrite && moving ? (
        <WorkflowRecategorize record={{ ...record, id }} onClose={() => setMoving(false)} />
      ) : null}
    </Page>
  );
}
