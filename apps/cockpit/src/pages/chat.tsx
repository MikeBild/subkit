import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, List, MessageSquarePlus, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useState } from "react";
import {
  appendConversationMessage,
  type Conversation,
  cancelConversation,
  createConversation,
  getConversation,
  listConversations,
  respondToToolCall,
  type UiMessage,
} from "@/api/client";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
  Conversation as ConversationViewport,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";

const QUICK_START: readonly TranslationKey[] = [
  "chat.quick.workflow",
  "chat.quick.list",
  "chat.quick.failure",
  "chat.quick.connector",
];

type Translate = ReturnType<typeof useI18n>["t"];

function localizedSummary(value: string | null | undefined, t: Translate): string {
  if (!value) return t("chat.summary");
  if (value === "You have an in-progress conversation. Continue the conversation.")
    return t("chat.summary.inProgress");
  return hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
}

function localizedStage(value: string | null | undefined, t: Translate): string {
  if (!value) return t("chat.context.ready");
  if (value === "onboarding") return t("chat.context.onboarding");
  return value;
}

function localizedTarget(value: string | null | undefined, t: Translate): string {
  if (!value || value.toLowerCase() === "none") return t("chat.context.noTarget");
  return hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
}

function localizedNextAction(value: string | null | undefined, t: Translate): string {
  if (!value) return t("chat.context.nextActionDefault");
  if (value === "Continue the conversation.") return t("chat.context.continue");
  return hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
}

function textFromPart(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : null;
}

export function asToolPart(part: unknown): ToolPart | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    !(record.type === "dynamic-tool" || record.type.startsWith("tool-"))
  )
    return null;
  return part as ToolPart;
}

function ChatMessage({
  message,
  messageIndex,
  onDecision,
}: {
  message: UiMessage;
  messageIndex: number;
  onDecision: (toolCallId: string, approved: boolean) => void;
}) {
  const { t } = useI18n();
  const from = message.role === "user" ? "user" : "assistant";
  return (
    <Message
      from={from}
      data-cockpit-ui="chat-message"
      data-testid={`chat-message-${messageIndex}`}
    >
      <MessageContent data-testid={`chat-message-${messageIndex}-content`}>
        {message.parts.map((part, partIndex) => {
          const text = textFromPart(part);
          if (text)
            return (
              <MessageResponse
                key={`${message.id}-text-${partIndex}`}
                data-testid={`chat-message-${messageIndex}-text-${partIndex}`}
              >
                {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
              </MessageResponse>
            );
          const tool = asToolPart(part);
          if (!tool) return null;
          return (
            <Tool
              key={`${message.id}-tool-${partIndex}`}
              defaultOpen={tool.state !== "output-available"}
              data-testid={`chat-message-${messageIndex}-tool-${partIndex}`}
            >
              {tool.type === "dynamic-tool" ? (
                <ToolHeader
                  type={tool.type}
                  state={tool.state}
                  toolName={tool.toolName}
                  data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
                />
              ) : (
                <ToolHeader
                  type={tool.type}
                  state={tool.state}
                  data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
                />
              )}
              <ToolContent>
                <ToolInput input={tool.input} />
                <Confirmation approval={tool.approval} state={tool.state}>
                  <ConfirmationRequest>
                    <ConfirmationTitle>{t("chat.approval.review")}</ConfirmationTitle>
                    <ConfirmationActions>
                      <ConfirmationAction
                        variant="outline"
                        data-testid={`chat-message-${messageIndex}-tool-${partIndex}-decline`}
                        onClick={() => onDecision(tool.toolCallId, false)}
                      >
                        {t("chat.approval.decline")}
                      </ConfirmationAction>
                      <ConfirmationAction
                        data-testid={`chat-message-${messageIndex}-tool-${partIndex}-approve`}
                        onClick={() => onDecision(tool.toolCallId, true)}
                      >
                        {t("chat.approval.approve")}
                      </ConfirmationAction>
                    </ConfirmationActions>
                  </ConfirmationRequest>
                </Confirmation>
                <ToolOutput output={tool.output} errorText={tool.errorText} />
              </ToolContent>
            </Tool>
          );
        })}
      </MessageContent>
    </Message>
  );
}

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: readonly Conversation[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="conversation-list">
      <div className="flex items-center justify-between p-3">
        <p className="text-sm font-semibold">{t("chat.conversations")}</p>
        <IconButton label={t("chat.new")} data-testid="conversation-new" onClick={onNew}>
          <MessageSquarePlus />
        </IconButton>
      </div>
      <Separator />
      <ScrollArea className="h-0 min-h-0 flex-1">
        <div className="grid gap-1 p-2">
          {conversations.map((conversation, index) => (
            <button
              key={conversation.id}
              type="button"
              data-testid={`conversation-item-${index}`}
              onClick={() => onSelect(conversation.id)}
              className={cn(
                "w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted",
                activeId === conversation.id && "bg-muted text-foreground",
              )}
            >
              <span className="block truncate text-sm font-medium">
                {conversation.title || t("chat.untitled")}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {conversationExcerpt(
                  conversation.last_message_excerpt,
                  t("chat.toolActivity"),
                  t("tool.referenceHidden"),
                ) || statusLabel(t, conversation.status)}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ChatPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(true);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const initialPrompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: listConversations });
  const activeId = selectedId ?? conversations.data?.items[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["conversation", activeId],
    queryFn: () => getConversation(activeId ?? ""),
    enabled: Boolean(activeId),
  });
  const send = useMutation({
    mutationFn: async (message: string) =>
      activeId ? appendConversationMessage(activeId, message) : createConversation(message),
    onSuccess: async (result) => {
      setSelectedId(result.conversation.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", result.conversation.id] }),
      ]);
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelConversation(activeId ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation", activeId] }),
  });
  const decide = useMutation({
    mutationFn: ({ toolCallId, approved }: { toolCallId: string; approved: boolean }) =>
      respondToToolCall(activeId ?? "", toolCallId, approved),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", result.conversation.id] }),
      ]);
    },
  });
  const current = detail.data?.conversation;
  const messages = detail.data?.messages ?? [];
  const resume = detail.data?.resume_summary;
  const status = send.isPending ? "submitted" : send.isError ? "error" : "ready";
  const ordered = useMemo(
    () =>
      [...(conversations.data?.items ?? [])].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      ),
    [conversations.data],
  );
  const list = (
    <ConversationList
      conversations={ordered}
      activeId={activeId}
      onNew={() => {
        setSelectedId(null);
        setMobileListOpen(false);
      }}
      onSelect={(id) => {
        setSelectedId(id);
        setMobileListOpen(false);
      }}
    />
  );

  return (
    <div
      className="grid h-full min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_18rem]"
      data-cockpit-ui="chat-workspace"
      data-testid="chat-workspace"
    >
      <aside
        className="hidden min-h-0 border-r bg-muted/20 lg:flex"
        data-testid="conversation-sidebar"
      >
        {list}
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col" data-testid="chat-main">
        <header
          className="flex min-h-14 items-center justify-between gap-3 border-b px-4 py-2"
          data-testid="chat-header"
        >
          <div className="flex min-w-0 items-center gap-2">
            <IconButton
              className="lg:hidden"
              label={t("chat.conversations")}
              data-testid="conversation-list-mobile-trigger"
              onClick={() => setMobileListOpen(true)}
            >
              <List />
            </IconButton>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold" data-testid="chat-title">
                {current?.title || t("chat.new")}
              </h1>
              <p className="truncate text-xs text-muted-foreground" data-testid="chat-summary">
                {localizedSummary(resume?.one_sentence, t)}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {current && (
              <Badge variant="outline" data-testid="chat-status">
                {statusLabel(t, current.status)}
              </Badge>
            )}
            {send.isPending && activeId && (
              <Button
                size="sm"
                variant="outline"
                data-testid="chat-stop"
                onClick={() => cancel.mutate()}
              >
                <CircleStop data-icon="inline-start" />
                <span className="hidden sm:inline">{t("chat.stop")}</span>
              </Button>
            )}
            <IconButton
              className="hidden xl:inline-flex"
              label={t("chat.toggleContext")}
              data-testid="chat-context-toggle"
              onClick={() => setContextOpen((open) => !open)}
            >
              {contextOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </IconButton>
          </div>
        </header>

        {send.error && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-error">
            <AlertTitle>{t("chat.failed")}</AlertTitle>
            <AlertDescription>{send.error.message}</AlertDescription>
          </Alert>
        )}

        <ConversationViewport className="h-0 min-h-0 flex-1" data-testid="chat-transcript">
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {messages.length === 0 ? (
              <ConversationEmptyState
                title={t("chat.empty.title")}
                description={t("chat.empty.description")}
                icon={<MessageSquarePlus />}
                data-testid="chat-empty"
              />
            ) : (
              messages.map((message, index) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  messageIndex={index}
                  onDecision={(toolCallId, approved) => decide.mutate({ toolCallId, approved })}
                />
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton
            label={t("chat.scrollBottom")}
            data-testid="chat-scroll-bottom"
          />
        </ConversationViewport>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4" data-testid="chat-composer-area">
          {messages.length === 0 && (
            <Suggestions className="mb-2" data-testid="chat-suggestions">
              {QUICK_START.map((key, index) => (
                <Suggestion
                  key={key}
                  suggestion={t(key)}
                  data-testid={`chat-suggestion-${index}`}
                  onClick={(suggestion) => send.mutate(suggestion)}
                />
              ))}
            </Suggestions>
          )}
          <PromptInputProvider initialInput={initialPrompt}>
            <PromptInput
              data-testid="chat-composer"
              onSubmit={async ({ text }) => {
                const trimmed = text.trim();
                if (trimmed) await send.mutateAsync(trimmed);
              }}
            >
              <PromptInputBody>
                <PromptInputTextarea
                  name="message"
                  placeholder={t("chat.composer.placeholder")}
                  disabled={send.isPending}
                  data-testid="chat-composer-input"
                />
              </PromptInputBody>
              <PromptInputFooter>
                <PromptInputTools>
                  <span className="px-2 text-xs text-muted-foreground">
                    {t("chat.composer.mode")}
                  </span>
                </PromptInputTools>
                <PromptInputSubmit
                  status={status}
                  disabled={send.isPending}
                  aria-label={t("chat.submit")}
                  tooltip={t("chat.submit")}
                  data-testid="chat-composer-submit"
                />
              </PromptInputFooter>
            </PromptInput>
          </PromptInputProvider>
        </div>
      </section>

      {contextOpen && (
        <aside
          className="hidden min-h-0 border-l xl:flex xl:flex-col"
          data-cockpit-ui="context-panel"
          data-testid="chat-context"
        >
          <div className="p-4">
            <p className="text-sm font-semibold">{t("chat.context.title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("chat.context.description")}</p>
          </div>
          <Separator />
          <ScrollArea className="h-0 min-h-0 flex-1">
            <dl className="grid gap-4 p-4 text-sm">
              <div data-testid="chat-context-stage">
                <dt className="text-xs text-muted-foreground">{t("chat.context.stage")}</dt>
                <dd className="mt-1 font-medium">{localizedStage(resume?.stage, t)}</dd>
              </div>
              <div data-testid="chat-context-target">
                <dt className="text-xs text-muted-foreground">{t("chat.context.target")}</dt>
                <dd className="mt-1 font-medium">
                  {localizedTarget(resume?.active_target.name || resume?.active_target.kind, t)}
                </dd>
              </div>
              <div data-testid="chat-context-next-action">
                <dt className="text-xs text-muted-foreground">{t("chat.context.nextAction")}</dt>
                <dd className="mt-1">{localizedNextAction(resume?.next_action, t)}</dd>
              </div>
              <div data-testid="chat-context-checkpoint">
                <dt className="text-xs text-muted-foreground">{t("chat.context.checkpoint")}</dt>
                <dd className="mt-1">
                  {t(resume?.unsaved ? "chat.context.unsaved" : "chat.context.saved")}
                </dd>
              </div>
              {resume?.pending_approval && (
                <div
                  className="rounded-lg border border-warning/40 bg-warning/10 p-3"
                  data-testid="chat-context-approval"
                >
                  <dt className="text-xs font-medium">{t("chat.context.approval")}</dt>
                  <dd className="mt-1 text-xs">{resume.pending_approval.summary}</dd>
                </div>
              )}
            </dl>
          </ScrollArea>
        </aside>
      )}

      <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
        <SheetContent
          side="left"
          className="w-80 p-0"
          closeLabel={t("common.close")}
          closeTestId="conversation-list-mobile-close"
          data-testid="conversation-list-mobile"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("chat.conversations")}</SheetTitle>
          </SheetHeader>
          {list}
        </SheetContent>
      </Sheet>
    </div>
  );
}
