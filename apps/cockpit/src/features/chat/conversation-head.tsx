import { BookOpen, PanelRight } from "lucide-react";
import { ApiError } from "@/api/client";
import { IconButton } from "@/components/cockpit/icon-button";
import { ActionMenu, Button, StatusBadge, StatusStrip } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { refusedApprovalReply } from "@/pages/chat-policy";
import type { ChatTurn } from "@/pages/chat-turn";
import { chatContextControlsTarget } from "@/pages/chat-workspace";
import { ReadingColumn } from "./parts";
import { RefusedReply } from "./policy";

export function ConversationHead({
  headerText,
  badge,
  listOpen,
  onToggleList,
  playbook,
  contextToggle,
  contextOpen,
  setContextOpen,
  hasConversation,
  menuItems,
}: {
  headerText: string;
  badge: { label: string; state: string } | null;
  listOpen: boolean;
  onToggleList: () => void;
  playbook: boolean;
  contextToggle: React.RefObject<HTMLButtonElement | null>;
  contextOpen: boolean;
  setContextOpen: (open: boolean) => void;
  hasConversation: boolean;
  menuItems: Parameters<typeof ActionMenu>[0]["items"];
}) {
  const { t } = useI18n();
  return (
    <div className="py-3 md:pt-6 md:pb-0" data-testid="chat-conversation-head">
      <div className="flex min-h-8 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          data-testid="chat-title"
          title={headerText}
        >
          {headerText}
        </span>
        {hasConversation && badge ? (
          <span className="hidden sm:inline-flex">
            <StatusBadge state={badge.state} label={badge.label} testId="chat-status" />
          </span>
        ) : null}
        <Button
          variant="ghost"
          className="md:hidden"
          aria-expanded={listOpen}
          aria-controls="chat-conversation-list"
          onClick={onToggleList}
          data-testid="conversation-list-trigger"
        >
          {t("chat.conversations")}
        </Button>
        <IconButton
          label={t(playbook ? "chat.playbook.title" : "chat.toggleContext")}
          ref={contextToggle}
          data-testid="chat-context-toggle"
          aria-expanded={contextOpen}
          aria-controls={chatContextControlsTarget(contextOpen, hasConversation)}
          disabled={!hasConversation}
          onClick={() => setContextOpen(!contextOpen)}
        >
          {playbook ? <BookOpen /> : <PanelRight />}
        </IconButton>
        {menuItems.length > 0 ? <ActionMenu items={menuItems} testId="chat-menu" /> : null}
      </div>
    </div>
  );
}

export function TurnErrors({
  turn,
  busy,
  questionOpen,
}: {
  turn: ChatTurn;
  busy: boolean;
  questionOpen: boolean;
}) {
  const { t } = useI18n();
  const { send, sendError, turnFailure, failureCauseText, turnFailureMessage, retryTurn, decide } =
    turn;
  const blocked = sendError instanceof ApiError && sendError.code === "pending_elicitation_blocked";
  const refusedReply = sendError instanceof ApiError && refusedApprovalReply(sendError) !== null;
  return (
    <>
      {refusedReply && questionOpen ? (
        <ReadingColumn className="pb-3">
          <RefusedReply turn={turn} busy={busy} />
        </ReadingColumn>
      ) : null}
      {(send.error || turnFailure) && !refusedReply && (
        <ReadingColumn className="pb-3">
          <StatusStrip
            tone="error"
            testId="chat-error"
            line={
              blocked ? (
                t(
                  (sendError instanceof ApiError
                    ? (sendError.details?.pending_elicitation as
                        | { tool_name?: unknown }
                        | undefined)
                    : undefined
                  )?.tool_name === "ask_user_text"
                    ? "chat.text.blocked"
                    : "chat.pendingQuestionRequired",
                )
              ) : (
                <span data-testid={failureCauseText ? "chat-error-cause" : undefined}>
                  {failureCauseText ?? t("chat.failed")}
                </span>
              )
            }
            help={
              blocked
                ? undefined
                : [
                    t(failureCauseText ? "chat.failedKept" : "chat.failedDescription"),
                    failureCauseText ? null : t("chat.retryManual"),
                    turnFailureMessage,
                  ]
                    .filter(Boolean)
                    .join(" ")
            }
            action={
              blocked ? undefined : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void retryTurn()}
                  data-testid="chat-error-retry"
                >
                  {t("chat.retryCheck")}
                </Button>
              )
            }
          />
        </ReadingColumn>
      )}

      {decide.isError && !questionOpen && (
        <ReadingColumn className="pb-3">
          <StatusStrip tone="error" testId="chat-decision-error" line={t("chat.decision.failed")} />
        </ReadingColumn>
      )}
    </>
  );
}
