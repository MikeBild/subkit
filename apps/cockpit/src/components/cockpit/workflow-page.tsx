import { Bot, MessageCircleQuestion, MoreHorizontal, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { absolute, chatNewHref } from "@/app/links";
import { AgentPanel } from "@/components/cockpit/agent-panel";
import {
  AutomationPanel,
  AutomationTitleAction,
  useWorkflowAutomation,
} from "@/components/cockpit/automation-panel";
import { ContextHelp } from "@/components/cockpit/context-help";
import { ConversationsAbout } from "@/components/cockpit/conversations-about";
import { RemedyLink, useWorkflowRemedy } from "@/components/cockpit/detail-action";
import { IconButton } from "@/components/cockpit/icon-button";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
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
import { automationActionPermitted, automationTitleAction } from "@/lib/automation-state";
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
 * The further actions beside the title. Several stand behind "⋯"; a single
 * one is a named button — the glyph is reserved for a real menu.
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
 * approvals — is folded below. Every fact has one home.
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
  };

  const automation = useWorkflowAutomation(id, workflow, permissions);
  const remedy = useWorkflowRemedy(id, title, permissions);
  // The automation state's pending step leads; a calm state leaves the title
  // to the page's ordinary action. Nothing is shown until the state is known —
  // an action that changes under the pointer is worse than a moment without.
  const stateAction = automation.state ? automationTitleAction(automation.state) : null;
  const pending =
    stateAction &&
    automationActionPermitted(stateAction, { write: canWrite, run: canRun, chat: canChat })
      ? stateAction
      : null;
  const settled = automation.state !== null || automation.failed;
  const ordinary = settled && !pending ? remedy : null;
  const changeHref = absolute(
    chatNewHref({ workflowId: id, prompt: t("detail.changePrompt", { name: title }) }),
  );

  const entries: MenuEntry[] = [
    // "Im Chat ändern" stays reachable while the title carries another action.
    ...(canChat && ordinary?.kind !== "chat"
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
      <header
        data-family-slot="detail-header"
        className="flex flex-wrap items-center justify-between gap-4 border-b p-6"
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            <WorkflowHealthBadge state={text(record, "health_state")} />
          </div>
          {purpose ? <p className="mt-1 text-sm text-muted-foreground">{purpose}</p> : null}
        </div>
        <div data-family-slot="detail-actions" className="flex flex-wrap items-center gap-2">
          {canRun ? (
            <RunWorkflowDialog
              workflowId={id}
              workflowName={title}
              version={version === null ? null : String(version)}
              versionId={versionId}
            />
          ) : null}
          {pending ? (
            <AutomationTitleAction automation={automation} action={pending} workflowName={title} />
          ) : ordinary ? (
            <RemedyLink remedy={ordinary} />
          ) : null}
          <FurtherActions entries={entries} />
          <ContextHelp label={t("detail.editHelp.label")} testId="workflow-edit-help">
            {t(canWrite ? "detail.canEdit" : "detail.readOnly")}
          </ContextHelp>
        </div>
      </header>
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
        />
        <AutomationPanel automation={automation} workflow={workflow} workflowName={title} />
        <WorkflowInvocation workflowId={id} effectiveTrigger={effectiveTrigger} />
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
