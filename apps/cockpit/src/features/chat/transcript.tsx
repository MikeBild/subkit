import { Fragment } from "react";
import type { ConversationDetail } from "@/api/client";
import { CHAT_COLUMN } from "@/app/shell-header";
import { MessageResponse } from "@/components/ai-elements/message";
import { DiffCard } from "@/components/cockpit/diff-card";
import {
  Bubble,
  BubbleContent,
  CodeBlock,
  DataState,
  Message,
  MessageContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { elapsedMs } from "@/pages/chat-live-calls";
import type { ChatLookups } from "@/pages/chat-lookups";
import type { ChatQuestions } from "@/pages/chat-questions";
import { optimisticUiMessage } from "@/pages/chat-session";
import { ChatStart } from "@/pages/chat-start";
import type { ChatTurn } from "@/pages/chat-turn";
import { actionLabel, NO_LIVE_REVIEWS } from "./labels";
import { ChatMessage } from "./message";
import { FollowSubmittedTurn } from "./parts";

export function ChatTranscript({
  turn,
  questions,
  lookups,
  activeId,
  messages,
  conversationFailed,
  conversationMissing,
  onRetryLoad,
  startEmpty,
  fillComposer,
  showOptimistic,
  busy,
  decisionErrorFor,
  openStoredFile,
  playbookPlacement,
  playbookSummary,
  dock,
}: {
  turn: ChatTurn;
  questions: ChatQuestions;
  lookups: ChatLookups;
  activeId: string | null;
  messages: ConversationDetail["messages"];
  conversationFailed: boolean;
  conversationMissing: boolean;
  onRetryLoad: () => void;
  startEmpty: boolean;
  fillComposer: (prompt: string) => void;
  showOptimistic: boolean;
  busy: boolean;
  decisionErrorFor: (id: string | undefined) => boolean;
  openStoredFile: (fileId: string) => void;
  playbookPlacement: { inlineIndex: number | null; atEnd: boolean };
  playbookSummary: React.ReactNode;
  dock: React.ReactNode;
}) {
  const { t } = useI18n();
  const {
    sessionKey,
    send,
    decide,
    sendPending,
    optimistic,
    liveCalls,
    liveTick,
    streamedDiffs,
    streamedText,
    submitTurn,
    submitForm,
    submitChoice,
    submitApproval,
    beginOperation,
  } = turn;
  const { pendingDecision, pendingChoice, pendingForm, pendingText } = questions;
  const {
    answerMessageIds,
    nameFor,
    workflowNameFor,
    attachmentFor,
    liveReviewCalls,
    latestPreviewCallId,
    savedPreviews,
  } = lookups;
  return (
    <MessageScrollerProvider key={sessionKey} autoScroll>
      <FollowSubmittedTurn submittedAt={Math.max(send.submittedAt, decide.submittedAt)} />
      <MessageScroller className="h-0 min-h-0 flex-1" data-testid="chat-transcript">
        <MessageScrollerViewport
          className="px-4 py-6 sm:px-6"
          style={{ scrollbarGutter: "stable" }}
        >
          <MessageScrollerContent className={CHAT_COLUMN}>
            {conversationFailed ? (
              <DataState
                state="error"
                line={t(conversationMissing ? "chat.notFound" : "chat.loadFailed")}
                onRetry={conversationMissing ? undefined : onRetryLoad}
                testId="chat-load-failed"
              />
            ) : messages.length === 0 && !sendPending && !showOptimistic ? (
              <div className="flex flex-1 py-6" data-testid="chat-empty">
                {startEmpty ? (
                  <p className="text-sm text-muted-foreground">{t("chat.empty.title")}</p>
                ) : (
                  <ChatStart onPick={fillComposer} />
                )}
              </div>
            ) : (
              messages.map((message, index) => (
                <Fragment key={message.id}>
                  <MessageScrollerItem>
                    <ChatMessage
                      conversationId={activeId ?? undefined}
                      message={message}
                      messageIndex={index}
                      pendingApprovalId={
                        pendingDecision?.toolCallId ??
                        pendingChoice?.toolCallId ??
                        pendingForm?.toolCallId ??
                        pendingText?.toolCallId ??
                        null
                      }
                      approval={pendingDecision}
                      choice={pendingChoice}
                      form={pendingForm}
                      text={pendingText}
                      onForm={submitForm}
                      onChoice={submitChoice}
                      answersQuestion={answerMessageIds.has(message.id)}
                      approvalBusy={busy}
                      approvalError={decisionErrorFor(
                        pendingDecision?.id ??
                          pendingChoice?.id ??
                          pendingForm?.id ??
                          pendingText?.id,
                      )}
                      onApproval={submitApproval}
                      nameFor={nameFor}
                      workflowNameFor={workflowNameFor}
                      attachmentFor={attachmentFor}
                      onOpenFile={openStoredFile}
                      liveReviews={liveReviewCalls}
                      onAutomationAdjust={(workflowId) =>
                        void submitTurn(t("authority.adjustPrompt"), [
                          {
                            type: "workflow",
                            id: workflowId,
                            label: t("chat.singleRun.thisWorkflow"),
                          },
                        ])
                      }
                      onAutomationSingleRun={(workflowId) =>
                        void submitTurn(t("chat.activation.singlePrompt"), [
                          {
                            type: "workflow",
                            id: workflowId,
                            label: t("chat.singleRun.thisWorkflow"),
                          },
                        ])
                      }
                      latestPreviewCallId={latestPreviewCallId}
                      savedPreviews={savedPreviews}
                      onInstruction={(instruction) =>
                        void submitTurn(instruction.message, instruction.references)
                      }
                      onReauth={(action) =>
                        void submitTurn(t("chat.reauth.prompt"), [
                          {
                            type: "connector",
                            id: action.connectorId,
                            label: action.label || t("chat.reauth.title"),
                          },
                        ])
                      }
                      onDecision={(toolCallId, approved) =>
                        decide.mutate({
                          toolCallId,
                          approved,
                          conversationId: activeId ?? "",
                          operation: beginOperation(),
                        })
                      }
                    />
                  </MessageScrollerItem>
                  {index === playbookPlacement.inlineIndex ? playbookSummary : null}
                </Fragment>
              ))
            )}
            {showOptimistic && optimistic ? (
              <MessageScrollerItem key="optimistic" data-testid="chat-pending-message">
                <ChatMessage
                  conversationId={activeId ?? undefined}
                  message={optimisticUiMessage(optimistic)}
                  messageIndex={messages.length}
                  pendingApprovalId={null}
                  approval={null}
                  choice={null}
                  form={null}
                  onForm={() => {}}
                  onChoice={() => {}}
                  approvalBusy
                  approvalError={false}
                  onApproval={() => {}}
                  onDecision={() => {}}
                  onReauth={() => {}}
                  onAutomationAdjust={() => {}}
                  onAutomationSingleRun={() => {}}
                  onInstruction={() => {}}
                  liveReviews={NO_LIVE_REVIEWS}
                  nameFor={nameFor}
                  workflowNameFor={workflowNameFor}
                />
              </MessageScrollerItem>
            ) : null}
            {liveCalls.length > 0 && (
              <MessageScrollerItem>
                <div className="grid gap-1" data-testid="chat-live-calls" data-tick={liveTick}>
                  {liveCalls.map((call, index) => {
                    const running = elapsedMs(call, Date.now());
                    return (
                      <div
                        key={call.callId}
                        className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground"
                        data-action-scope="live-call"
                        data-testid={`chat-live-call-${index}`}
                      >
                        <span className="font-medium">
                          {call.toolName ? actionLabel(t, call.toolName) : t("tool.action")}
                        </span>
                        {call.logTail && (
                          <details className="min-w-0 w-full">
                            <summary>{t("chat.activity.details")}</summary>
                            <CodeBlock code={call.logTail} />
                          </details>
                        )}
                        {running !== null && (
                          <span className="tabular-nums">
                            {t("overview.recent.duration", {
                              seconds: String(Math.round(running / 1000)),
                            })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </MessageScrollerItem>
            )}
            {streamedDiffs.length > 0 && (
              <MessageScrollerItem>
                <div className="grid gap-3" data-testid="chat-streamed-diffs">
                  {streamedDiffs.map((diff, index) => (
                    <DiffCard
                      key={`${diff.title}-${index}`}
                      testId={`chat-streamed-diff-${index}`}
                      targetLabel={diff.title}
                      before={null}
                      after={null}
                      lines={diff.lines}
                    />
                  ))}
                </div>
              </MessageScrollerItem>
            )}
            {streamedText && (
              <MessageScrollerItem>
                <Message align="start">
                  <MessageContent>
                    <Bubble variant="ghost">
                      <BubbleContent>
                        <MessageResponse>{streamedText}</MessageResponse>
                      </BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            )}
            {playbookPlacement.atEnd ? playbookSummary : null}
            {dock}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          direction="end"
          label={t("chat.scrollBottom")}
          data-testid="chat-scroll-bottom"
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
