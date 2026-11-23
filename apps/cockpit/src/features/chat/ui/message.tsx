import { ChatBubble } from "@ui/molecules/chat-bubble";
import { ToolApprovalCard } from "@ui/organisms/tool-approval-card";
import { FileText } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { UiMessage } from "@/api/client";
import { BackgroundTools } from "@/components/ai-elements/background-tools";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Bubble, BubbleContent, Message, MessageContent } from "@/components/cockpit/patterns";
import { AutomationToolCard } from "@/features/grants";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { nameIdentifiers, type ResolvedIdentifier } from "@/lib/identifiers";
import { hideTechnicalIdentifiers } from "@/lib/presentation";
import {
  isStaleCall,
  isWorkflowRunTool,
  toolOutcomeKey,
  workflowRefusalKey,
  workflowResultLink,
  workflowRunKind,
} from "@/lib/tool-presentation";
import { type ConversationAttachment, splitFileSentinels } from "../api/attachments";
import {
  type ChatApproval,
  type ChatApprovalOptions,
  recordedDecisionKey,
  withWorkflowName,
} from "../model/approval";
import { bubbleSide } from "../model/bubble-model";
import type { ChatChoice } from "../model/choice";
import { answerSources } from "../model/citations";
import type { ChatForm } from "../model/form";
import {
  actionLabel,
  backgroundLabel,
  didNotRun,
  NO_SAVED_PREVIEWS,
  textFromPart,
} from "../model/labels";
import {
  type ChatInstruction,
  type ChatWorkflowRef,
  chatJudgeFindings,
  chatSensitivePreview,
} from "../model/preview-cards";
import { type ChatReauth, chatReauth } from "../model/reauth";
import { referencesFromPart } from "../model/references";
import { messageAuthor } from "../model/session";
import { isRunContinuation } from "../model/task-run";
import { chatSensitiveTestRun } from "../model/test-run";
import type { ChatText } from "../model/text";
import { patchCandidateId, toolNameOf, toolPartVerdict } from "../model/tool-parts";
import { dedupeBackground, groupMessageParts } from "../model/transcript";
import { ChatApprovalCard } from "./approval-card";
import { ChatChoiceCard } from "./choice-card";
import { ChatFormCard } from "./form-card";
import { ChatJudgeFindingsCard } from "./judge-findings-card";
import { MentionChips } from "./mention-picker";
import { CHAT_MARKDOWN_COMPONENTS } from "./message-link";
import { AttachmentChip, PatchProposalDiff, ResultLink } from "./parts";
import { ToolPolicyNote } from "./policy";
import { ChatReauthCard } from "./reauth-card";
import { ChatSensitivePreviewCard } from "./sensitive-preview-card";
import { SourcesLine } from "./sources-line";
import { ChatTestRunCard } from "./test-run-card";

export function ChatMessage({
  conversationId,
  message,
  messageIndex,
  pendingApprovalId,
  approval,
  choice,
  form,
  text = null,
  onForm,
  onChoice,
  answersQuestion = false,
  approvalBusy,
  approvalError,
  onApproval,
  onDecision,
  onReauth,
  onAutomationAdjust,
  onAutomationSingleRun,
  onInstruction,
  latestPreviewCallId = null,
  savedPreviews = NO_SAVED_PREVIEWS,
  liveReviews,
  nameFor,
  workflowNameFor,
  attachmentFor = () => null,
  onOpenFile = () => {},
  continued = false,
}: {
  conversationId?: string;
  message: UiMessage;
  messageIndex: number;
  pendingApprovalId: string | null;
  approval: ChatApproval | null;
  choice: ChatChoice | null;
  form: ChatForm | null;
  text?: ChatText | null;
  onForm: (id: string, output: Record<string, unknown>) => void;
  onChoice: (id: string, value: string) => void;
  answersQuestion?: boolean;
  approvalBusy: boolean;
  approvalError: boolean;
  onApproval: (id: string, approved: boolean, options?: ChatApprovalOptions) => void;
  onDecision: (toolCallId: string, approved: boolean) => void;
  onReauth: (action: ChatReauth) => void;
  onAutomationAdjust: (workflowId: string) => void;
  onAutomationSingleRun: (workflowId: string) => void;
  onInstruction: (instruction: ChatInstruction) => void;
  latestPreviewCallId?: string | null;
  savedPreviews?: ReadonlyMap<string, ChatWorkflowRef>;
  liveReviews: ReadonlySet<string>;
  nameFor: (id: string) => ResolvedIdentifier | null;
  workflowNameFor: (slug: string) => string | null;
  attachmentFor?: (fileId: string) => ConversationAttachment | null;
  onOpenFile?: (fileId: string) => void;
  continued?: boolean;
}) {
  const { t, locale } = useI18n();
  const from = messageAuthor(message.role);
  const side = bubbleSide(message.role);
  let bubbles = 0;
  const bubble = (key: string, testId: string, body: ReactNode) => {
    const joined = continued || bubbles > 0;
    bubbles += 1;
    if (side === "system")
      return (
        <Bubble key={key} variant="ghost" align="start">
          <BubbleContent data-testid={testId}>{body}</BubbleContent>
        </Bubble>
      );
    return (
      <ChatBubble key={key} answer={side === "answer"} continued={joined}>
        <div className="min-w-0 [overflow-wrap:anywhere]" data-testid={testId}>
          {body}
        </div>
      </ChatBubble>
    );
  };
  const aside = (key: string, node: ReactNode) =>
    side === "subkit" ? (
      <div key={key} className="mt-2 min-w-0 pl-10">
        {node}
      </div>
    ) : (
      <Fragment key={key}>{node}</Fragment>
    );
  if (isRunContinuation(message))
    return (
      <p
        className="flex items-center gap-3 text-xs text-muted-foreground"
        data-cockpit-ui="chat-run-continues"
        data-testid={`chat-message-${messageIndex}-continues`}
      >
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        {t("chat.taskRun.continues")}
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </p>
    );
  const groups = groupMessageParts(message.parts, pendingApprovalId).filter(
    (group) => group.kind !== "part" || Boolean(textFromPart(group.part)?.trim()),
  );
  if (groups.length === 0) return null;
  const sources = from === "assistant" ? answerSources(message) : { shown: [], more: 0 };
  return (
    <Message
      align="start"
      data-cockpit-ui="chat-message"
      data-action-scope="message"
      data-testid={`chat-message-${messageIndex}`}
      data-side={side}
      title={
        from === "assistant"
          ? [message.model, formatDateTime(locale, message.created_at)].filter(Boolean).join(" · ")
          : undefined
      }
    >
      <MessageContent className="gap-0" data-testid={`chat-message-${messageIndex}-content`}>
        {from === "system" ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid={`chat-message-${messageIndex}-role`}
          >
            {t("chat.role.system")}
          </span>
        ) : null}
        {answersQuestion ? (
          <span className="sr-only" data-testid={`chat-message-${messageIndex}-answer-to`}>
            {t("chat.text.answerTo")}
          </span>
        ) : null}
        {groups.map((group) => {
          const node = renderGroup(group);
          const isText = group.kind === "part" && !recordedDecisionKey(group.part);
          return isText ? node : aside(`${message.id}-aside-${group.index}`, node);
        })}
        {sources.shown.length > 0
          ? aside(
              `${message.id}-sources`,
              <SourcesLine sources={sources} testId={`chat-message-${messageIndex}-sources`} />,
            )
          : null}
      </MessageContent>
    </Message>
  );

  function renderGroup(group: (typeof groups)[number]): ReactNode {
    if (group.kind === "background") {
      return (
        <BackgroundTools
          key={`${message.id}-bg-${group.index}`}
          testId={`chat-message-${messageIndex}-background-${group.index}`}
          lines={dedupeBackground(group.tools).map((line) => ({
            label: backgroundLabel(t, line.toolName, line.running),
            count: line.count,
            running: line.running,
          }))}
        />
      );
    }
    if (group.kind === "part") {
      const raw = textFromPart(group.part);
      if (!raw) return null;
      const recorded = recordedDecisionKey(group.part);
      if (recorded)
        return (
          <p
            key={`${message.id}-decision-${group.index}`}
            className="text-sm text-muted-foreground"
            data-testid={`chat-message-${messageIndex}-decision`}
          >
            {t("chat.decision.recorded", { verdict: t(recorded) })}
          </p>
        );
      const split = from === "user" ? splitFileSentinels(raw) : { text: raw, fileIds: [] };
      const text = split.text;
      const mentions = from === "user" ? referencesFromPart(group.part) : null;
      const files =
        split.fileIds.length > 0 ? (
          <div
            key={`${message.id}-files-${group.index}`}
            className="flex flex-wrap gap-1.5"
            data-testid={`chat-message-${messageIndex}-files`}
          >
            {split.fileIds.map((fileId, index) => {
              const linked = attachmentFor(fileId);
              return (
                <AttachmentChip
                  key={fileId}
                  name={linked?.filename ?? t("chat.attachment.file")}
                  size={linked?.size_bytes}
                  icon={FileText}
                  onOpen={() => onOpenFile(fileId)}
                  testId={`chat-message-${messageIndex}-file-${index}`}
                />
              );
            })}
          </div>
        ) : null;
      if (!text && !files) return null;
      return bubble(
        `${message.id}-text-${group.index}`,
        `chat-message-${messageIndex}-text-${group.index}`,
        <>
          {!text ? null : mentions && mentions.references.length > 0 ? (
            <MentionChips
              text={text}
              references={mentions.references}
              unresolved={mentions.unresolved}
              hiddenLabel={t("tool.referenceHiddenInline")}
              testIdPrefix={`chat-message-${messageIndex}-text-${group.index}`}
            />
          ) : (
            <MessageResponse components={CHAT_MARKDOWN_COMPONENTS}>
              {nameIdentifiers(text, nameFor, t("chat.referenceUnnamed"))}
            </MessageResponse>
          )}
          {files ? <div className={text ? "mt-2" : undefined}>{files}</div> : null}
        </>,
      );
    }
    const tool = group.tool;
    const partIndex = group.index;
    if (approval?.toolCallId === tool.toolCallId) {
      return (
        <ChatApprovalCard
          key={`${message.id}-approval-${partIndex}`}
          approval={withWorkflowName(approval, workflowNameFor)}
          conversationId={conversationId}
          busy={approvalBusy}
          error={approvalError}
          onDecision={onApproval}
          testId={`chat-message-${messageIndex}-approval`}
        />
      );
    }
    if (form?.toolCallId === tool.toolCallId)
      return (
        <ChatFormCard
          key={`${message.id}-form-${partIndex}`}
          form={form}
          busy={approvalBusy}
          error={approvalError}
          onAnswer={onForm}
          testId={`chat-message-${messageIndex}-form`}
        />
      );
    if (text?.toolCallId === tool.toolCallId)
      return (
        <div
          key={`${message.id}-question-${partIndex}`}
          className="rounded-xl bg-secondary px-4 py-3 text-sm"
          data-testid={`chat-message-${messageIndex}-question`}
        >
          <MessageResponse components={CHAT_MARKDOWN_COMPONENTS}>
            {nameIdentifiers(text.question, nameFor, t("chat.referenceUnnamed"))}
          </MessageResponse>
        </div>
      );
    if (choice?.toolCallId === tool.toolCallId) {
      return (
        <ChatChoiceCard
          key={`${message.id}-choice-${partIndex}`}
          choice={choice}
          busy={approvalBusy}
          error={approvalError}
          onAnswer={onChoice}
          testId={`chat-message-${messageIndex}-choice`}
        />
      );
    }
    if (liveReviews.has(tool.toolCallId))
      return (
        <AutomationToolCard
          key={`${message.id}-automation-${partIndex}`}
          tool={tool}
          conversationId={conversationId}
          onAdjust={onAutomationAdjust}
          onPrepareSingleRun={onAutomationSingleRun}
        />
      );
    const reauth = chatReauth(tool, window.location.origin);
    if (reauth)
      return (
        <ChatReauthCard
          key={`${message.id}-reauth-${partIndex}`}
          action={reauth}
          connectorName={nameFor(reauth.connectorId)?.label || reauth.label || null}
          pending={Boolean(approval || choice || form)}
          busy={approvalBusy}
          onRenew={onReauth}
        />
      );
    const sensitiveTestRun = chatSensitiveTestRun(tool);
    if (sensitiveTestRun)
      return (
        <ChatTestRunCard
          key={`${message.id}-test-run-${partIndex}`}
          run={sensitiveTestRun}
          saved={savedPreviews.get(tool.toolCallId) ?? null}
          latest={tool.toolCallId === latestPreviewCallId}
        />
      );
    const sensitivePreview = chatSensitivePreview(tool);
    if (sensitivePreview)
      return (
        <ChatSensitivePreviewCard
          key={`${message.id}-preview-${partIndex}`}
          preview={sensitivePreview}
          saved={savedPreviews.get(tool.toolCallId) ?? null}
          testId={`chat-message-${messageIndex}-preview-${partIndex}`}
        />
      );
    const judgeFindings = chatJudgeFindings(tool);
    if (judgeFindings)
      return (
        <ChatJudgeFindingsCard
          key={`${message.id}-findings-${partIndex}`}
          findings={judgeFindings}
          disabled={
            approvalBusy ||
            Boolean(approval || choice || form) ||
            tool.toolCallId !== latestPreviewCallId
          }
          onInstruction={onInstruction}
          testId={`chat-message-${messageIndex}-findings-${partIndex}`}
        />
      );
    const candidateId = patchCandidateId(tool);
    const verdict = toolPartVerdict(tool);
    const stale = isStaleCall({
      messageCreatedAt: message.created_at,
      hasResult:
        tool.state === "output-available" ||
        tool.state === "output-error" ||
        tool.state === "output-denied",
      isStreaming: false,
      now: Date.now(),
    });
    const answeredQuestion =
      tool.type === "dynamic-tool" &&
      (tool.toolName === "ask_user_choice" ||
        tool.toolName === "ask_user_text" ||
        tool.toolName === "ask_user_form") &&
      verdict.outcome === "ok";
    const choiceStatus =
      tool.type === "dynamic-tool"
        ? (tool.output as { status?: string } | undefined)?.status
        : null;
    const outcomeKey =
      choiceStatus === "timeout"
        ? "chat.choice.expired"
        : choiceStatus === "cancelled"
          ? "chat.choice.cancelled"
          : answeredQuestion
            ? "chat.outcome.answered"
            : toolOutcomeKey({
                confirmationState: verdict.confirmationState,
                outcome: verdict.outcome,
                stale,
              });
    const notRun = didNotRun(verdict);
    const runKind =
      notRun || !isWorkflowRunTool(toolNameOf(tool)) ? null : workflowRunKind(tool.output);
    const refusalKey = runKind === "refused" ? workflowRefusalKey(tool.output) : null;
    const headerOutcomeKey = refusalKey ?? outcomeKey;
    const askedQuestion =
      tool.type === "dynamic-tool" && tool.toolName === "ask_user_text"
        ? (tool.input as { question?: unknown } | undefined)?.question
        : undefined;
    if (typeof askedQuestion === "string" && askedQuestion.trim() && outcomeKey !== null)
      return (
        <div
          key={`${message.id}-asked-${partIndex}`}
          className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
          data-testid={`chat-message-${messageIndex}-asked-${partIndex}`}
        >
          <p className="text-xs text-muted-foreground">
            {t("chat.text.answeredQuestion")} · {t(outcomeKey)}
          </p>
          <p className="mt-1 whitespace-pre-line">
            {hideTechnicalIdentifiers(askedQuestion, t("tool.referenceHiddenInline"))}
          </p>
        </div>
      );
    const resultLink =
      tool.type === "dynamic-tool" && verdict.outcome === "ok"
        ? workflowResultLink(tool.output)
        : null;
    return (
      <Fragment key={`${message.id}-tool-${partIndex}`}>
        <Tool defaultOpen={false} data-testid={`chat-message-${messageIndex}-tool-${partIndex}`}>
          {tool.type === "dynamic-tool" ? (
            <ToolHeader
              type={tool.type}
              state={tool.state}
              toolName={tool.toolName}
              title={actionLabel(
                t,
                tool.toolName,
                notRun,
                workflowNameFor,
                runKind,
                stale,
                tool.output,
              )}
              outcomeKey={headerOutcomeKey}
              data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
            />
          ) : (
            <ToolHeader
              type={tool.type}
              state={tool.state}
              title={actionLabel(
                t,
                tool.type.replace(/^tool-/, ""),
                notRun,
                workflowNameFor,
                runKind,
                stale,
                tool.output,
              )}
              outcomeKey={headerOutcomeKey}
              data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
            />
          )}
          <ToolContent>
            {stale && (
              <p
                className="text-muted-foreground text-sm"
                data-testid={`chat-message-${messageIndex}-tool-${partIndex}-stale`}
              >
                {t("tool.stale.description")}
              </p>
            )}
            <ToolInput input={tool.input} />
            {candidateId && (
              <PatchProposalDiff
                candidateId={candidateId}
                testId={`chat-message-${messageIndex}-tool-${partIndex}-diff`}
              />
            )}
            {tool.approval && tool.state === "approval-requested" ? (
              <ToolApprovalCard
                testId={`chat-message-${messageIndex}-tool-${partIndex}`}
                title={t("chat.approval.review")}
                labels={{
                  approve: t("chat.approval.approve"),
                  decline: t("chat.approval.decline"),
                }}
                showPending={false}
                footnote={null}
                onDecision={(allow) => onDecision(tool.toolCallId, allow)}
              />
            ) : null}
            <ToolOutput output={tool.output} errorText={tool.errorText} />
          </ToolContent>
        </Tool>
        <ToolPolicyNote
          conversationId={conversationId}
          toolCallId={tool.toolCallId}
          testId={`chat-message-${messageIndex}-tool-${partIndex}-policy`}
        />
        {resultLink ? (
          <ResultLink
            link={resultLink}
            testId={`chat-message-${messageIndex}-tool-${partIndex}-link`}
          />
        ) : null}
      </Fragment>
    );
  }
}
