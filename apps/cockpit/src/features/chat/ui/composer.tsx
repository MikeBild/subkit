import { IconButton } from "@ui/molecules/icon-button";
import { FileText, Paperclip, SendHorizontal } from "lucide-react";
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationReference } from "@/api/client";
import { chatSeedFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { Button, Popover, PopoverAnchor } from "@/components/cockpit/patterns";
import {
  useMentionCandidates,
  useSeedMentionReferences,
} from "@/features/chat/api/mention-sources";
import {
  dedupeReferences,
  mentionTokenText,
  reconcileReferences,
} from "@/features/chat/model/mentions";
import { useI18n } from "@/lib/i18n-context";
import { useDirtyGuard } from "@/lib/use-dirty-guard";
import {
  attachmentName,
  attachmentSize,
  type PendingAttachment,
  pendingKey,
  takeAttachmentFiles,
} from "../api/attachments";
import type { RestoreComposer } from "../model/labels";
import { type ChatText, composerAnswerAccepted } from "../model/text";
import type { TrayChip } from "../model/tray-model";
import { MentionPicker, useMentionInput } from "./mention-picker";
import { AttachmentChip } from "./parts";
import { ComposerTrayChips } from "./tray-view";

export function ChatComposer({
  disabled,
  status,
  placeholder,
  describedBy,
  attachments,
  onAttach,
  onRemoveAttachment,
  onOpenAttachment,
  onSend,
  onStop,
  restoreRef,
  answer,
  tray = [],
  onOpenTray = () => {},
  onRemoveTray = () => {},
}: {
  disabled: boolean;
  status: React.ComponentProps<typeof PromptInputSubmit>["status"];
  placeholder: string;
  describedBy?: string;
  attachments: readonly PendingAttachment[];
  onAttach: (attachments: PendingAttachment[]) => void;
  onRemoveAttachment: (key: string) => void;
  onOpenAttachment: (attachment: PendingAttachment) => void;
  onSend: (message: string, references: ConversationReference[]) => Promise<boolean>;
  onStop: () => void;
  restoreRef: MutableRefObject<RestoreComposer | null>;
  answer: ChatText | null;
  tray?: readonly TrayChip[];
  onOpenTray?: (chip: TrayChip) => void;
  onRemoveTray?: (id: string) => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const controller = usePromptInputController();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [references, setReferences] = useState<ConversationReference[]>([]);
  const seedReferences = useMemo(() => chatSeedFromUrl(window.location.search).references, []);
  const seeded = useSeedMentionReferences(seedReferences);
  const seededKey = useMemo(
    () => seeded.references.map((reference) => `${reference.type}:${reference.id}`).join(","),
    [seeded.references],
  );
  const seedsApplied = seedReferences.every((seed) =>
    references.some((reference) => reference.type === seed.type && reference.id === seed.id),
  );
  const seedPending = seeded.isBlocked || !seedsApplied;
  const appliedSeed = useRef<string | null>(null);
  const setInput = controller.textInput.setInput;
  const [answerRejected, setAnswerRejected] = useState(false);
  const answerId = answer?.id ?? null;
  const answerDefault = answer?.initialValue ?? null;
  const currentInput = useRef(controller.textInput.value);
  currentInput.current = controller.textInput.value;
  useEffect(() => {
    setAnswerRejected(false);
    if (answerId && answerDefault && !currentInput.current.trim()) setInput(answerDefault);
  }, [answerId, answerDefault, setInput]);
  useEffect(() => {
    if (!seededKey || appliedSeed.current === seededKey) return;
    appliedSeed.current = seededKey;
    setReferences((current) => dedupeReferences([...seeded.references, ...current]));
    const tokens = seeded.references.map(mentionTokenText).join(" ");
    const text = controller.textInput.value;
    setInput(text ? `${tokens} ${text}` : tokens);
  }, [controller.textInput.value, seeded.references, seededKey, setInput]);
  useEffect(() => {
    restoreRef.current = (text, restored) => {
      setInput(text);
      setReferences(restored);
    };
    return () => {
      restoreRef.current = null;
    };
  }, [restoreRef, setInput]);
  const [query, setQuery] = useState<string | null>(null);
  const { candidates, isLoading } = useMentionCandidates(query, session.permissions);
  const mentions = useMentionInput({
    value: controller.textInput.value,
    setValue: controller.textInput.setInput,
    textareaRef,
    references,
    setReferences,
    candidates,
    onQueryChange: setQuery,
    onPickFile: (candidate) =>
      onAttach([
        {
          key: pendingKey(),
          kind: "file",
          id: candidate.id,
          name: candidate.title,
          size: candidate.size,
          contentType: candidate.contentType,
        },
      ]),
  });
  const take = (files: readonly File[]) => {
    const taken = takeAttachmentFiles(files, t);
    if (taken.length > 0) onAttach(taken);
  };
  const streaming = status === "streaming";
  useDirtyGuard(controller.textInput.value.trim().length > 0 || attachments.length > 0);
  return (
    <Popover open={mentions.open} onOpenChange={(open) => !open && mentions.close()}>
      <PopoverAnchor asChild>
        <div className="relative">
          <MentionPicker
            open={mentions.open}
            groups={mentions.groups}
            highlighted={mentions.highlighted}
            loading={isLoading}
            onHighlight={mentions.setHighlighted}
            onSelect={mentions.select}
          />
          <PromptInput
            data-testid="chat-composer"
            inputGroupClassName="h-auto gap-1.5 rounded-xl p-2 has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30"
            onSubmit={async ({ text }) => {
              if (seedPending) return;
              const trimmed = text.trim();
              if (!trimmed && attachments.length === 0 && tray.length === 0) return;
              if (!composerAnswerAccepted(answer, trimmed)) {
                setAnswerRejected(true);
                throw new Error("answer rejected");
              }
              setAnswerRejected(false);
              const sent = reconcileReferences(trimmed, references);
              controller.textInput.clear();
              setReferences([]);
              if (!(await onSend(trimmed, sent))) throw new Error("request handed back");
            }}
          >
            {attachments.length > 0 || tray.length > 0 ? (
              <PromptInputHeader className="p-0" data-testid="chat-attachments">
                {attachments.map((attachment, index) => (
                  <AttachmentChip
                    key={attachment.key}
                    name={attachmentName(attachment)}
                    size={attachmentSize(attachment)}
                    icon={FileText}
                    onOpen={() => onOpenAttachment(attachment)}
                    onRemove={() => onRemoveAttachment(attachment.key)}
                    testId={`chat-attachment-${index}`}
                  />
                ))}
                <ComposerTrayChips chips={tray} onOpen={onOpenTray} onRemove={onRemoveTray} />
              </PromptInputHeader>
            ) : null}
            <PromptInputBody>
              <PromptInputTextarea
                ref={textareaRef}
                name="message"
                className="min-h-10 px-2 py-1 leading-6"
                placeholder={placeholder}
                aria-label={t("chat.composer.label")}
                aria-describedby={describedBy}
                aria-invalid={answerRejected || undefined}
                disabled={disabled || seedPending}
                onKeyDown={(event) => {
                  mentions.onKeyDown(event);
                }}
                onChange={(event) => {
                  setAnswerRejected(false);
                  mentions.onChange(event.currentTarget.value, event.currentTarget.selectionStart);
                }}
                onClick={(event) => mentions.onCaretMove(event.currentTarget.selectionStart)}
                onKeyUp={(event) => {
                  if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
                    mentions.onCaretMove(event.currentTarget.selectionStart);
                }}
                onPaste={(event) => {
                  const files = [...(event.clipboardData?.files ?? [])];
                  if (files.length === 0) return;
                  event.preventDefault();
                  take(files);
                }}
                onBlur={mentions.close}
                data-testid="chat-composer-input"
              />
            </PromptInputBody>
            <PromptInputFooter className="p-0" data-testid="chat-composer-tools">
              <IconButton
                label={t("chat.attach")}
                disabled={disabled}
                onClick={() => fileInputRef.current?.click()}
                data-testid="chat-attach"
              >
                <Paperclip />
              </IconButton>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  take([...(event.currentTarget.files ?? [])]);
                  event.currentTarget.value = "";
                }}
                data-testid="chat-attach-input"
              />
              <PromptInputSubmit
                variant="outline"
                status={status}
                onStop={onStop}
                disabled={streaming ? false : disabled || seedPending}
                aria-label={t(streaming ? "chat.stop" : "chat.submit")}
                tooltip={t(streaming ? "chat.stop" : "chat.submit")}
                data-testid="chat-composer-submit"
              >
                {streaming ? undefined : <SendHorizontal className="size-4" />}
              </PromptInputSubmit>
            </PromptInputFooter>
          </PromptInput>
          {answerRejected ? (
            <p
              role="alert"
              className="mt-1 text-sm text-destructive"
              data-testid="chat-composer-invalid"
            >
              {t("chat.text.invalid")}
            </p>
          ) : null}
          {seeded.isBlocked ? (
            <div
              className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="chat-reference-seed-pending"
            >
              <span>{t("chat.references.unavailable")}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={seeded.retry}
                data-testid="chat-reference-seed-retry"
              >
                {t("chat.activation.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverAnchor>
    </Popover>
  );
}
