import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, List, MessageSquarePlus, PanelRight, Pencil, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  appendConversationMessage,
  type Conversation,
  cancelConversation,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
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
import { MessageResponse } from "@/components/ai-elements/message";
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
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { conversationExcerpt, hideTechnicalIdentifiers } from "@/lib/presentation";
import { statusLabel } from "@/lib/status-label";
import { cn } from "@/lib/utils";
import { activeConversationId, type ConversationSelection } from "./chat-selection";

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
  const stageKeys: Partial<Record<string, TranslationKey>> = {
    onboarding: "chat.context.onboarding",
    authoring: "chat.context.authoring",
    discovery: "chat.context.discovery",
    diagnosis: "chat.context.diagnosis",
    repair: "chat.context.repair",
    execution: "chat.context.execution",
  };
  const key = stageKeys[value.toLowerCase()];
  return key ? t(key) : t("chat.context.ready");
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
      align={from === "user" ? "end" : "start"}
      data-cockpit-ui="chat-message"
      data-testid={`chat-message-${messageIndex}`}
    >
      <MessageContent data-testid={`chat-message-${messageIndex}-content`}>
        {message.parts.map((part, partIndex) => {
          const text = textFromPart(part);
          if (text)
            return (
              <Bubble
                key={`${message.id}-text-${partIndex}`}
                variant={from === "user" ? "default" : "ghost"}
                align={from === "user" ? "end" : "start"}
              >
                <BubbleContent data-testid={`chat-message-${messageIndex}-text-${partIndex}`}>
                  <MessageResponse>
                    {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
                  </MessageResponse>
                </BubbleContent>
              </Bubble>
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
  search,
  onSearchChange,
  onRename,
}: {
  conversations: readonly Conversation[];
  activeId: string | null;
  onSelect(id: string): void;
  onNew(): void;
  search: string;
  onSearchChange(value: string): void;
  onRename(conversation: Conversation): void;
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
      <div className="p-2">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("chat.search")}
            aria-label={t("chat.search")}
            data-testid="conversation-search"
          />
        </InputGroup>
      </div>
      <ScrollArea className="h-0 min-h-0 flex-1">
        <div className="grid gap-1 p-2">
          {conversations.map((conversation, index) => (
            <div key={conversation.id} className="group flex min-w-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                data-testid={`conversation-item-${index}`}
                onClick={() => onSelect(conversation.id)}
                className={cn(
                  "h-auto min-w-0 flex-1 justify-start rounded-lg px-3 py-2.5 text-left",
                  activeId === conversation.id && "bg-muted text-foreground hover:bg-muted",
                )}
              >
                <span className="block min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {conversation.title || t("chat.untitled")}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {conversationExcerpt(
                      conversation.last_message_excerpt,
                      t("chat.toolActivity"),
                      t("tool.referenceHidden"),
                    ) || statusLabel(t, conversation.status)}
                  </span>
                </span>
              </Button>
              <IconButton
                label={t("chat.rename")}
                variant="ghost"
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                data-testid={`conversation-rename-${index}`}
                onClick={() => onRename(conversation)}
              >
                <Pencil />
              </IconButton>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function selectionFromPath(initialPrompt: string): ConversationSelection {
  if (initialPrompt || window.location.pathname.endsWith("/chat/new")) return { kind: "new" };
  const match = window.location.pathname.match(/\/chat\/([^/?]+)$/);
  return match?.[1]
    ? { kind: "existing", id: decodeURIComponent(match[1]) }
    : { kind: "automatic" };
}

function setChatPath(id: string | null, replace = false): void {
  const path = id ? `/cockpit/chat/${encodeURIComponent(id)}` : "/cockpit/chat/new";
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
}

export function ChatPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const initialPrompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
  const [selection, setSelection] = useState<ConversationSelection>(() =>
    selectionFromPath(initialPrompt),
  );
  const [createOpen, setCreateOpen] = useState(
    Boolean(initialPrompt) || window.location.pathname.endsWith("/chat/new"),
  );
  const [createPrompt, setCreatePrompt] = useState(initialPrompt);
  const [conversationSearch, setConversationSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [streamedText, setStreamedText] = useState("");
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  useEffect(() => {
    const onPopState = () => {
      const prompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
      const next = selectionFromPath(prompt);
      setSelection(next);
      setCreateOpen(next.kind === "new");
      setCreatePrompt(prompt);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(conversationSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [conversationSearch]);
  const conversations = useQuery({
    queryKey: ["conversations", debouncedSearch],
    queryFn: () => listConversations(debouncedSearch),
  });
  const activeId = activeConversationId(selection, conversations.data?.items[0]?.id);
  useEffect(() => {
    if (selection.kind === "automatic" && activeId) setChatPath(activeId, true);
  }, [activeId, selection.kind]);
  const detail = useQuery({
    queryKey: ["conversation", activeId],
    queryFn: () => getConversation(activeId ?? ""),
    enabled: Boolean(activeId),
  });
  const send = useMutation({
    mutationFn: async (message: string) => {
      setStreamedText("");
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        if (event.type === "text_delta" && typeof event.text === "string") {
          setStreamedText((currentText) => currentText + event.text);
        }
      };
      if (activeId) return appendConversationMessage(activeId, message, onEvent);
      const params = new URLSearchParams(window.location.search);
      const workflowId = params.get("workflow_id");
      const connectorId = params.get("connector_id");
      return createConversation(message, onEvent, {
        ...(workflowId ? { workflow_id: workflowId } : {}),
        ...(connectorId ? { connector_id: connectorId } : {}),
      });
    },
    onSuccess: async (result) => {
      setSelection({ kind: "existing", id: result.conversation.id });
      setChatPath(result.conversation.id, true);
      setCreateOpen(false);
      setCreatePrompt("");
      setStreamedText("");
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
  const rename = useMutation({
    mutationFn: () => renameConversation(renameTarget?.id ?? "", renameTitle.trim()),
    onSuccess: async () => {
      setRenameTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
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
        setSelection({ kind: "new" });
        setChatPath(null);
        setCreatePrompt("");
        setCreateOpen(true);
        setMobileListOpen(false);
      }}
      onSelect={(id) => {
        setSelection({ kind: "existing", id });
        setChatPath(id);
        setMobileListOpen(false);
      }}
      search={conversationSearch}
      onSearchChange={setConversationSearch}
      onRename={(conversation) => {
        setRenameTarget(conversation);
        setRenameTitle(conversation.title || t("chat.untitled"));
      }}
    />
  );

  return (
    <div
      className="grid h-full min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)]"
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
          className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2"
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
              label={t("chat.toggleContext")}
              data-testid="chat-context-toggle"
              onClick={() => setContextOpen((open) => !open)}
            >
              <PanelRight />
            </IconButton>
          </div>
        </header>

        {send.error && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-error">
            <AlertTitle>{t("chat.failed")}</AlertTitle>
            <AlertDescription>{t("chat.failedDescription")}</AlertDescription>
          </Alert>
        )}

        <MessageScrollerProvider>
          <MessageScroller className="h-0 min-h-0 flex-1" data-testid="chat-transcript">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-6 px-5 py-6 sm:px-8">
                {messages.length === 0 ? (
                  <div
                    className="grid flex-1 place-items-center py-16 text-center"
                    data-testid="chat-empty"
                  >
                    <div className="max-w-md">
                      <span className="mx-auto grid size-10 place-items-center rounded-full bg-muted">
                        <MessageSquarePlus />
                      </span>
                      <h2 className="mt-4 font-semibold">{t("chat.empty.title")}</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("chat.empty.description")}
                      </p>
                    </div>
                  </div>
                ) : (
                  messages.map((message, index) => (
                    <MessageScrollerItem
                      key={message.id}
                      scrollAnchor={index === messages.length - 1}
                    >
                      <ChatMessage
                        message={message}
                        messageIndex={index}
                        onDecision={(toolCallId, approved) =>
                          decide.mutate({ toolCallId, approved })
                        }
                      />
                    </MessageScrollerItem>
                  ))
                )}
                {streamedText && (
                  <MessageScrollerItem scrollAnchor>
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
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton
              direction="end"
              aria-label={t("chat.scrollBottom")}
              data-testid="chat-scroll-bottom"
            />
          </MessageScroller>
        </MessageScrollerProvider>

        <div
          className="shrink-0 border-t bg-background/95 px-4 py-3 supports-[backdrop-filter]:backdrop-blur"
          data-testid="chat-composer-area"
        >
          <div className="mx-auto w-full max-w-3xl">
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
            <PromptInputProvider key={activeId ?? "new"} initialInput="">
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
        </div>
      </section>

      <Sheet open={contextOpen} onOpenChange={setContextOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-sm"
          closeLabel={t("common.close")}
          closeTestId="chat-context-close"
          data-cockpit-ui="context-panel"
          data-testid="chat-context"
        >
          <SheetHeader className="border-b p-4 pr-12">
            <SheetTitle>{t("chat.context.title")}</SheetTitle>
            <SheetDescription>{t("chat.context.description")}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
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
        </SheetContent>
      </Sheet>

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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open && selection.kind === "new") {
            setSelection({ kind: "automatic" });
            window.history.replaceState({}, "", "/cockpit/chat");
          }
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          data-testid="conversation-create-dialog"
          aria-describedby="conversation-create-description"
        >
          <DialogHeader>
            <DialogTitle>{t("chat.create.title")}</DialogTitle>
            <DialogDescription id="conversation-create-description">
              {t("chat.create.description")}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={send.isError || undefined}>
              <FieldLabel htmlFor="conversation-create-prompt">
                {t("chat.create.prompt")}
              </FieldLabel>
              <Textarea
                id="conversation-create-prompt"
                value={createPrompt}
                onChange={(event) => setCreatePrompt(event.target.value)}
                placeholder={t("chat.composer.placeholder")}
                rows={6}
                autoFocus
                data-testid="conversation-create-prompt"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              data-testid="conversation-create-cancel"
              onClick={() => {
                setCreateOpen(false);
                setSelection({ kind: "automatic" });
                window.history.replaceState({}, "", "/cockpit/chat");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!createPrompt.trim() || send.isPending}
              data-testid="conversation-create-submit"
              onClick={() => send.mutate(createPrompt.trim())}
            >
              {t(send.isPending ? "chat.create.starting" : "chat.create.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent data-testid="conversation-rename-dialog">
          <DialogHeader>
            <DialogTitle>{t("chat.rename")}</DialogTitle>
            <DialogDescription>{t("chat.renameDescription")}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="conversation-rename-title">{t("resource.field.title")}</FieldLabel>
            <Input
              id="conversation-rename-title"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              data-testid="conversation-rename-title"
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              data-testid="conversation-rename-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!renameTitle.trim() || rename.isPending}
              onClick={() => rename.mutate()}
              data-testid="conversation-rename-save"
            >
              {t("common.saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
