import { Bot, MessageCircleQuestion, MoreHorizontal, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { absolute, chatNewHref } from "@/app/links";
import { AgentPanel } from "@/components/cockpit/agent-panel";
import {
  AutomationPanel,
  automationPanelOffers,
  useWorkflowAutomation,
} from "@/components/cockpit/automation-panel";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { IconButton } from "@/components/cockpit/icon-button";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import { ContextHelp, PageHeader } from "@/components/cockpit/patterns";
import { RunWorkflowDialog } from "@/components/cockpit/run-workflow-dialog";
import { FormerGrants } from "@/components/cockpit/workflow-grants";
import { WorkflowInvocation } from "@/components/cockpit/workflow-invocation";
import { WorkflowInputOutput } from "@/components/cockpit/workflow-io";
import { RecentRuns, WorkflowCause, WorkflowHealthBadge } from "@/components/cockpit/workflow-runs";
import { WorkflowStepsList } from "@/components/cockpit/workflow-steps-list";
import { WorkflowTechnicalFacts } from "@/components/cockpit/workflow-technical-facts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

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

interface MenuEntry {
  key: string;
  labelKey: TranslationKey;
  icon: ReactNode;
  /** A link, or an act on this page. */
  href?: string;
  onSelect?: () => void;
}

/**
 * The page's further actions beside the title. Several stand behind "⋯"; a
 * single one is a named button — the glyph is reserved for a real menu.
 */
function FurtherActions({ entries }: { entries: readonly MenuEntry[] }) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [entry] = entries;
    if (!entry) return null;
    return entry.href ? (
      <Button asChild variant="outline">
        <a href={entry.href} data-testid={`workflow-menu-${entry.key}`}>
          {entry.icon}
          {t(entry.labelKey)}
        </a>
      </Button>
    ) : (
      <Button variant="outline" onClick={entry.onSelect} data-testid={`workflow-menu-${entry.key}`}>
        {entry.icon}
        {t(entry.labelKey)}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t("detail.moreActions")}
          variant="outline"
          size="icon"
          data-testid="workflow-menu"
        >
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {entries.map((entry) =>
          entry.href ? (
            <DropdownMenuItem key={entry.key} asChild>
              <a href={entry.href} data-testid={`workflow-menu-${entry.key}`}>
                {entry.icon}
                {t(entry.labelKey)}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={entry.key}
              onSelect={entry.onSelect}
              data-testid={`workflow-menu-${entry.key}`}
            >
              {entry.icon}
              {t(entry.labelKey)}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A workflow's page, in the order a reader asks: may it run on its own → how
 * is it called → what does it take and return → what does it do → how has it
 * been doing. Everything a reader does not decide by — technical facts, former
 * approvals — is folded below. Every fact has one home, and every action one
 * trigger: the header carries the page's own (run it, the menu), a section's
 * action stands in that section and nowhere else.
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
  const [asking, setAsking] = useState(false);
  const [renaming, setRenaming] = useState(false);
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
  const steps = Array.isArray(record.steps)
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

  const automation = useWorkflowAutomation(id, workflow, permissions);
  const changeHref = absolute(
    chatNewHref({ workflowId: id, prompt: t("detail.changePrompt", { name: title }) }),
  );

  const entries: MenuEntry[] = [
    ...(canChat
      ? [
          {
            key: "change",
            labelKey: "detail.changeInChat" as const,
            icon: <Bot data-icon="inline-start" />,
            href: changeHref,
          },
        ]
      : []),
    ...(canChat
      ? [
          {
            key: "ask",
            labelKey: "agentPanel.open" as const,
            icon: <MessageCircleQuestion data-icon="inline-start" />,
            onSelect: () => setAsking(true),
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            key: "rename",
            labelKey: "detail.editMetadata" as const,
            icon: <Pencil data-icon="inline-start" />,
            onSelect: () => setRenaming(true),
          },
        ]
      : []),
  ];

  return (
    <main
      data-family-surface="detail"
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid="detail-workflows"
    >
      <div className="shrink-0 px-6">
        <PageHeader
          back={{ to: "/workflows", label: t("nav.workflows") }}
          title={title}
          badge={<WorkflowHealthBadge state={text(record, "health_state")} />}
          purpose={purpose || undefined}
          secondary={
            <ContextHelp label={t("detail.editHelp.label")} testId="workflow-edit-help">
              {t(canWrite ? "detail.canEdit" : "detail.readOnly")}
            </ContextHelp>
          }
          menu={<FurtherActions entries={entries} />}
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
      </div>
      <div
        data-family-slot="detail-main"
        className="flex min-h-0 flex-1 flex-col gap-5 p-6 [&>*]:shrink-0"
      >
        <WorkflowCause
          workflowId={id}
          healthState={text(record, "health_state")}
          healthReason={text(record, "health_reason")}
          healthChangedAt={text(record, "health_changed_at")}
          permissions={permissions}
          panelOffers={automationPanelOffers(automation)}
        />
        <AutomationPanel automation={automation} workflow={workflow} workflowName={title} />
        <WorkflowInvocation
          workflowId={id}
          effectiveTrigger={effectiveTrigger}
          approvedEnvironment={
            automation.state?.state === "approved" ? automation.state.environment : null
          }
        />
        <WorkflowInputOutput
          workflowId={id}
          byWebhook={effectiveTrigger === "webhook" || webhooksActive > 0}
        />
        <WorkflowStepsList
          key={`${id}:${versionId ?? "none"}`}
          workflowId={id}
          versionId={versionId}
          steps={steps}
          definition={draftDefinition(record, steps)}
          canRun={canRun}
        />
        {permissions.includes("execution:read") ? <RecentRuns workflowId={id} /> : null}
        <WorkflowTechnicalFacts record={record} />
        <FormerGrants
          items={automation.state?.history ?? []}
          versions={automation.versions}
          now={automation.now}
          canWrite={canWrite}
          hasMore={automation.history.hasMore}
          loadingMore={automation.history.loading}
          onMore={automation.history.more}
        />
        {permissions.includes("conversation:read") ? (
          <ConversationsAbout target={{ workflow_id: id }} />
        ) : null}
      </div>
      {canChat ? (
        <AgentPanel workflowId={id} workflowName={title} open={asking} onOpenChange={setAsking} />
      ) : null}
      {canWrite ? (
        <MetadataDialog
          resource="workflows"
          id={id}
          title={title}
          open={renaming}
          onOpenChange={setRenaming}
        />
      ) : null}
    </main>
  );
}
