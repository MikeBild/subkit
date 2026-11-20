import { CHAT_COLUMN } from "@/app/shell-header";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  addAttachments,
  attachmentName,
  attachmentSize,
  type PendingAttachment,
} from "@/pages/chat-attachments";
import type { AuthoringMode } from "@/pages/chat-permission";
import type { ChatText } from "@/pages/chat-text";
import type { ChatTurn } from "@/pages/chat-turn";
import { ChatComposer } from "./composer";
import type { AttachmentPreview, ConversationUsage, RestoreComposer } from "./labels";
import { ModePill, UsagePills } from "./mode";

export function ChatComposerArea({
  turn,
  activeId,
  conversationFailed,
  busy,
  status,
  pillMode,
  pillLabel,
  runScope,
  setNewPermissionMode,
  composerHint,
  initialInput,
  choiceOpen,
  formOpen,
  pendingText,
  attachments,
  setAttachments,
  setPreview,
  restoreComposer,
  usage,
  budget,
}: {
  turn: ChatTurn;
  activeId: string | null;
  conversationFailed: boolean;
  busy: boolean;
  status: "streaming" | "ready";
  pillMode: AuthoringMode | null;
  pillLabel: string | null;
  runScope: string | null;
  setNewPermissionMode: (mode: AuthoringMode) => void;
  composerHint: { text: string; visible: boolean } | null;
  initialInput: string;
  choiceOpen: boolean;
  formOpen: boolean;
  pendingText: ChatText | null;
  attachments: PendingAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  setPreview: (preview: AttachmentPreview) => void;
  restoreComposer: React.RefObject<RestoreComposer | null>;
  usage: ConversationUsage | null | undefined;
  budget: "tightening" | "critical" | null;
}) {
  const { t } = useI18n();
  const { anyLive, streamedText, sendPending, sessionKey, cancel, submitTurn } = turn;
  return (
    <div
      className="scrollbar-thin shrink-0 overflow-y-auto px-4 sm:px-6 bg-background/95 pt-3 pb-3 supports-[backdrop-filter]:backdrop-blur [scrollbar-gutter:stable]"
      data-testid="chat-composer-area"
      hidden={conversationFailed}
    >
      <div className={CHAT_COLUMN}>
        {busy && (
          <div
            role="status"
            aria-live="polite"
            className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="chat-activity"
          >
            <Spinner aria-hidden="true" aria-label={undefined} />
            <span>
              {t(
                anyLive
                  ? "chat.activity.working"
                  : streamedText
                    ? "chat.activity.responding"
                    : "chat.activity.thinking",
              )}
            </span>
          </div>
        )}
        <div className="mb-2 flex min-h-6 flex-wrap items-center gap-1.5" data-testid="chat-pills">
          {runScope && !conversationFailed ? (
            <p className="text-xs text-muted-foreground" data-testid="chat-task-run-scope">
              {runScope}
            </p>
          ) : null}
          {conversationFailed || !pillLabel ? null : (
            <ModePill
              mode={pillMode}
              label={pillLabel}
              editable={!activeId}
              disabled={sendPending}
              onChange={setNewPermissionMode}
            />
          )}
        </div>
        {composerHint ? (
          <p
            id="chat-composer-hint"
            className={composerHint.visible ? "mb-2 text-sm text-muted-foreground" : "sr-only"}
            data-testid="chat-composer-hint"
          >
            {composerHint.text}
          </p>
        ) : null}
        <PromptInputProvider key={sessionKey} initialInput={initialInput}>
          <ChatComposer
            disabled={busy || choiceOpen || formOpen}
            locked={choiceOpen || formOpen}
            status={status}
            placeholder={
              pendingText
                ? (pendingText.placeholder ?? t("chat.text.placeholder"))
                : t("chat.composer.placeholder")
            }
            answer={pendingText}
            describedBy={composerHint ? "chat-composer-hint" : undefined}
            attachments={attachments}
            onAttach={(next) => setAttachments((current) => addAttachments(current, next))}
            onRemoveAttachment={(key) =>
              setAttachments((current) => current.filter((item) => item.key !== key))
            }
            onOpenAttachment={(attachment) =>
              setPreview({
                name: attachmentName(attachment),
                size: attachmentSize(attachment),
                ...(attachment.kind === "upload"
                  ? { file: attachment.file, contentType: attachment.file.type }
                  : { fileId: attachment.id, contentType: attachment.contentType }),
              })
            }
            onStop={() => cancel.mutate(activeId ?? "")}
            onSend={submitTurn}
            restoreRef={restoreComposer}
          />
        </PromptInputProvider>
        <div
          className="mt-2 flex min-h-6 flex-wrap items-center gap-1.5"
          data-testid="chat-usage-pills"
        >
          <UsagePills usage={usage} budget={budget} />
        </div>
      </div>
    </div>
  );
}
