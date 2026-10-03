import { useState } from "react";
import { absolute, chatNewHref } from "@/app/links";
import {
  useTriggerWords,
  useWorkflowAutomation,
  WorkflowStatus,
} from "@/components/cockpit/automation-panel";
import { useConnectorNames } from "@/components/cockpit/connector-names";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import {
  ActionMenu,
  type ActionMenuItem,
  CollapsibleSection,
  type Fact,
  FactList,
  Page,
  PageHeader,
  type PageTab,
  PageTabs,
  StatusBadge,
  SummaryLine,
} from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { MISSING } from "@/components/cockpit/table-columns";
import { WorkflowApprovals } from "@/components/cockpit/workflow-grants";
import { WorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";
import { WorkflowRuns } from "@/components/cockpit/workflow-runs";
import {
  useWorkflowSteps,
  WorkflowStepsList,
  WorkflowTestResult,
  WorkflowTestRun,
} from "@/components/cockpit/workflow-steps-list";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { connectorNameOf } from "@/lib/workflow-steps";
import { WorkflowRecategorize } from "@/pages/catalog";

type RecordValue = Record<string, unknown>;

const text = (record: RecordValue, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
};

/** The saved workflow replayed as a draft, so a preview never touches the stored version. */
function draftDefinition(record: RecordValue, steps: readonly RecordValue[]): RecordValue {
  return {
    name: text(record, "name") ?? "Preview",
    ...(text(record, "slug") ? { slug: record.slug } : {}),
    ...(text(record, "description") ? { description: record.description } : {}),
    steps,
  };
}

/** "Technische Angaben": what someone quoting the workflow needs, folded. */
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

/**
 * A workflow's page (V4): the header with its one filled action, the status
 * strip with the one action of its top state, and four tabs in the order a
 * reader asks — how do I call it, how has it been doing, what does it do, who
 * approved it. Each tab is a summary line, one main element and the rest
 * folded. Every fact has one home, and every action one trigger.
 */
export function WorkflowPage({
  id,
  record,
  title,
  purpose,
  permissions,
}: {
  id: string;
  record: RecordValue;
  /** The record's name, as the page heading. */
  title: string;
  /** What the workflow is for, in its author's words. Null when there are none. */
  purpose: string | null;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const canWrite = permissions.includes("workflow:write");
  const canRun = permissions.includes("workflow:run");
  const canChat = permissions.includes("conversation:write");
  const versionId = text(record, "current_version_id");
  // The running version is stored in an earlier format: the engine refuses to
  // run it, so the page does not offer a run it would refuse.
  const legacy = record.legacy === true;
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
    legacy,
  };
  const health = text(record, "health_state");

  const automation = useWorkflowAutomation(id, workflow, permissions);
  const steps = useWorkflowSteps({ workflowId: id, versionId, steps: stepRecords });
  const connectorNames = useConnectorNames();
  const triggerWords = useTriggerWords();
  const technical = useTechnicalFacts(record);

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
        ]
      : []),
  ];

  // "Verwenden": what starts it on its own and whether that runs live.
  const state = automation.state;
  const listedHooks = state?.triggers.filter((entry) => entry.kind === "hook").length ?? 0;
  const started =
    state && (state.triggers.length > 0 || webhooksActive > 0)
      ? triggerWords(state.triggers, listedHooks === 0 ? webhooksActive : 0).join(" · ")
      : null;
  const verdict =
    state?.state === "approved"
      ? t("workflowPage.approvedIn", {
          environment: t(
            state.environment === "prod" ? "authority.production" : "authority.development",
          ),
        })
      : null;
  const useSummary = state ? (
    <>
      {started ? (
        <span data-testid="workflow-automation-triggers">{started}</span>
      ) : (
        t("automation.headline.manual")
      )}
      {verdict ? ` · ${verdict}` : null}
    </>
  ) : null;
  // "Aufbau": version · steps · connectors.
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
              canRun && steps.views.length > 0 ? (
                <WorkflowTestRun steps={steps} definition={draftDefinition(record, stepRecords)} />
              ) : undefined
            }
            testId="workflow-build-summary"
          />
          <WorkflowTestResult steps={steps} />
          <WorkflowStepsList key={`${id}:${versionId ?? "none"}`} steps={steps} canRun={canRun} />
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
          badge={health ? <StatusBadge state={health} testId="workflow-health-badge" /> : undefined}
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
            canRun && !legacy ? (
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
          permissions={permissions}
        />
        <PageTabs tabs={tabs} param="tab" testId="workflow-tabs" />
      </div>
      {canWrite ? (
        <MetadataDialog
          resource="workflows"
          id={id}
          title={title}
          open={renaming}
          onOpenChange={setRenaming}
        />
      ) : null}
      {canWrite && moving ? (
        <WorkflowRecategorize record={{ ...record, id }} onClose={() => setMoving(false)} />
      ) : null}
    </Page>
  );
}
