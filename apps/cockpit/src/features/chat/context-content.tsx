import type { ConversationDetail, ConversationReference } from "@/api/client";
import type { HeldSchedule } from "@/api/decisions";
import { DataState, type Fact, FactList, StatusStrip } from "@/components/cockpit/patterns";
import { formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import { approvalLine, pendingApprovalSubject } from "@/pages/chat-approval";
import { HeldScheduleAction, heldScheduleCopy } from "@/pages/chat-held-schedule";
import { ChatPlaybookPanel } from "@/pages/chat-playbook-panel";
import type { ReferencedResource } from "@/pages/chat-references";
import { resumeStageLabel } from "@/pages/chat-resume";
import { catalogHref, localizedTarget } from "./labels";

export function ChatContextContent({
  playbook,
  playbookActionTargetFor,
  openPlaybookQuestion,
  refreshFailed,
  current,
  origin,
  anyQuestion,
  decidePending,
  resume,
  nextAction,
  heldTarget,
  targetWorkflowId,
  showScheduleStep,
  activeId,
  status,
  setContextOpen,
  submitTurn,
  referencedResources,
  createdResources,
}: {
  playbook: NonNullable<ConversationDetail["playbook"]> | null;
  playbookActionTargetFor: Parameters<typeof ChatPlaybookPanel>[0]["actionTarget"];
  openPlaybookQuestion: (id: string) => void;
  refreshFailed: boolean;
  current: ConversationDetail["conversation"] | undefined;
  origin: string;
  anyQuestion: boolean;
  decidePending: boolean;
  resume: ConversationDetail["resume_summary"] | undefined;
  nextAction: string | null;
  heldTarget: HeldSchedule | undefined;
  targetWorkflowId: string | null;
  showScheduleStep: boolean;
  activeId: string | null;
  status: "streaming" | "ready";
  setContextOpen: (open: boolean) => void;
  submitTurn: (message: string, references?: ConversationReference[]) => Promise<boolean>;
  referencedResources: ReferencedResource[];
  createdResources: NonNullable<ConversationDetail["created_resources"]>;
}) {
  const { t, locale } = useI18n();
  const target = resume?.active_target;
  const targetNamed = Boolean(target && target.kind !== "none" && (target.name || target.kind));
  const contextFacts: Fact[] = [
    ...(current && origin
      ? [{ label: t("chat.context.origin"), value: origin, testId: "chat-origin" }]
      : []),
    ...(anyQuestion
      ? []
      : [
          {
            label: t("chat.context.stage"),
            value: decidePending
              ? t("chat.decision.processing")
              : resumeStageLabel(resume?.stage, t),
            help: resume?.one_sentence
              ? hideTechnicalIdentifiers(resume.one_sentence, t("tool.referenceHiddenInline"))
              : undefined,
            testId: "chat-context-stage",
          },
        ]),
    ...(targetNamed
      ? [
          {
            label: t("chat.context.target"),
            value: localizedTarget(target?.name || target?.kind, t),
            testId: "chat-context-target",
          },
        ]
      : []),
    ...(nextAction
      ? [
          {
            label: t("chat.context.nextAction"),
            value: nextAction,
            testId: "chat-context-next-action",
          },
        ]
      : []),
    ...(heldTarget && targetWorkflowId && !showScheduleStep
      ? [
          {
            label: t(heldScheduleCopy(heldTarget).title),
            value: (
              <span className="flex flex-col items-start gap-2">
                <span>{t(heldScheduleCopy(heldTarget).line)}</span>
                <HeldScheduleAction
                  schedule={heldTarget}
                  conversationId={activeId ?? undefined}
                  workflowId={targetWorkflowId}
                  testId="chat-context-review-schedule"
                  busy={status !== "ready"}
                  onPrepareSingleRun={() => {
                    setContextOpen(false);
                    void submitTurn(t("chat.activation.singlePrompt"));
                  }}
                  onRepair={() => {
                    setContextOpen(false);
                    void submitTurn(t("authority.adjustPrompt"));
                  }}
                />
              </span>
            ),
            testId: "chat-context-held-schedule",
          },
        ]
      : []),
    ...(current
      ? [
          {
            label: t("chat.context.checkpoint"),
            value: t(resume?.unsaved ? "chat.context.unsaved" : "chat.context.saved"),
            testId: "chat-context-checkpoint",
          },
        ]
      : []),
    ...(resume?.pending_approval && !anyQuestion
      ? [
          {
            label: t("chat.context.approval"),
            value: approvalLine(
              pendingApprovalSubject(resume.pending_approval, resume.active_target.name),
              t,
              (text) => hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline")),
            ),
            testId: "chat-context-approval",
          },
        ]
      : []),
  ];
  const references = referencedResources;
  if (references.length > 0)
    contextFacts.push({
      label: t("chat.context.references"),
      testId: "chat-context-references",
      value: (
        <ul className="grid gap-1.5">
          {references.map((resource, index) => (
            <li
              key={`${resource.type}-${resource.id}`}
              className="flex min-w-0 items-center gap-2"
              data-testid={`chat-context-reference-${index}`}
            >
              {resource.unresolved ? (
                <span className="min-w-0 flex-1 truncate">{resource.label}</span>
              ) : (
                <a
                  className="min-w-0 flex-1 truncate underline-offset-4 hover:underline"
                  data-testid={`chat-context-reference-link-${index}`}
                  href={catalogHref(resource.type, resource.id)}
                >
                  {resource.label}
                </a>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {resource.unresolved
                  ? t("chat.context.referenceUnavailable")
                  : `${t(`chat.created.kind.${resource.type}`)} · ${formatRelativeTime(locale, resource.at)}`}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  if (createdResources.length > 0)
    contextFacts.push({
      label: t("chat.created.title"),
      testId: "chat-context-created",
      value: (
        <ul className="grid gap-1">
          {createdResources.map((resource, index) => (
            <li key={`${resource.kind}-${resource.id}`} className="flex items-baseline gap-2">
              <a
                className="truncate underline-offset-4 hover:underline"
                href={catalogHref(resource.kind, resource.id)}
                data-testid={`chat-context-created-${index}`}
              >
                {resource.name || resource.slug || t(`chat.created.kind.${resource.kind}`)}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(`chat.created.kind.${resource.kind}`)} ·{" "}
                {formatRelativeTime(locale, resource.at)}
              </span>
            </li>
          ))}
        </ul>
      ),
    });

  return (
    <div id="chat-context-content" className="min-w-0">
      {playbook ? (
        <>
          <ChatPlaybookPanel
            key={playbook.id}
            playbook={playbook}
            actionTarget={playbookActionTargetFor}
            onOpenQuestion={openPlaybookQuestion}
          />
          {refreshFailed ? (
            <StatusStrip tone="warn" line={t("chat.playbook.refreshFailed")} />
          ) : null}
          {contextFacts.length > 0 ? (
            <details className="mt-5 border-t pt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("chat.playbook.context")}
              </summary>
              <div className="pt-3">
                <FactList items={contextFacts} testId="chat-context-facts" />
              </div>
            </details>
          ) : null}
        </>
      ) : contextFacts.length > 0 ? (
        <FactList items={contextFacts} testId="chat-context-facts" />
      ) : (
        <DataState state="empty" line={t("chat.context.empty")} testId="chat-context-empty" />
      )}
    </div>
  );
}
