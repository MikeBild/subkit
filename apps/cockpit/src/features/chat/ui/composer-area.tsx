import type { ReactNode } from "react";
import { CHAT_COLUMN } from "@/app/shell-header";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Spinner } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import {
  addAttachments,
  attachmentName,
  attachmentSize,
  type PendingAttachment,
} from "../api/attachments";
import { useComposerTray } from "../hooks/tray";
import type { ChatTurn } from "../hooks/turn";
import type { AttachmentPreview, RestoreComposer } from "../model/labels";
import type { ChatText } from "../model/text";
import { BudgetPill } from "./budget-pill";
import { ChatComposer } from "./composer";
import { ComposerTrayNotice } from "./tray-view";

export function ChatComposerArea({
  turn,
  activeId,
  conversationFailed,
  busy,
  status,
  runScope,
  composerHint,
  initialInput,
  pendingText,
  attachments,
  setAttachments,
  setPreview,
  restoreComposer,
  budget,
  starters,
}: {
  turn: ChatTurn;
  activeId: string | null;
  conversationFailed: boolean;
  busy: boolean;
  status: "streaming" | "ready";
  runScope: string | null;
  composerHint: { text: string; visible: boolean } | null;
  initialInput: string;
  pendingText: ChatText | null;
  attachments: PendingAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  setPreview: (preview: AttachmentPreview) => void;
  restoreComposer: React.RefObject<RestoreComposer | null>;
  budget: "tightening" | "critical" | null;
  starters?: ReactNode;
}) {
  const { t } = useI18n();
  const { anyLive, streamedText, sessionKey, cancel, submitTurn } = turn;
  const tray = useComposerTray(sessionKey);
  return (
    <div
      className="scrollbar-thin shrink-0 overflow-y-auto px-4 sm:px-8 bg-background/95 pt-3 pb-3 supports-[backdrop-filter]:backdrop-blur [scrollbar-gutter:stable]"
      data-testid="chat-composer-area"
      hidden={conversationFailed}
    >
      <div className={CHAT_COLUMN}>
        {busy && (
          <div
            role="status"
            aria-live="polite"
            className={
              anyLive ? "mb-2 flex items-center gap-2 text-sm text-muted-foreground" : "sr-only"
            }
            data-testid="chat-activity"
          >
            {anyLive ? <Spinner aria-hidden="true" aria-label={undefined} /> : null}
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
        </div>
        {starters}
        {composerHint ? (
          <p
            id="chat-composer-hint"
            className={composerHint.visible ? "mb-2 text-sm text-muted-foreground" : "sr-only"}
            data-testid="chat-composer-hint"
          >
            {composerHint.text}
          </p>
        ) : null}
        <ComposerTrayNotice
          problems={tray.problems}
          onRemove={(ids) => void tray.remove(ids)}
          onDismiss={tray.dismiss}
        />
        <PromptInputProvider key={sessionKey} initialInput={initialInput}>
          <ChatComposer
            disabled={busy}
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
            tray={tray.chips}
            onOpenTray={(chip) =>
              setPreview({
                name: chip.name,
                size: chip.size,
                fileId: chip.fileId,
                contentType: chip.contentType,
              })
            }
            onRemoveTray={(id) => void tray.remove([id])}
            onSend={async (message, references) => {
              const ids = tray.chips.map((chip) => chip.id);
              tray.hold(ids);
              const sent = await submitTurn(message, references, ids);
              if (!sent) tray.release(ids);
              return sent;
            }}
            restoreRef={restoreComposer}
          />
        </PromptInputProvider>
        <BudgetPill budget={budget} />
      </div>
    </div>
  );
}
