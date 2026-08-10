import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop, MessageSquarePlus, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useState } from "react";
import {
  appendConversationMessage,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const QUICK_START = [
  "Build a workflow from a business outcome",
  "Show my workflows and suggest the next useful action",
  "Investigate the latest failed run",
  "Connect a service and verify its access",
] as const;

function textFromPart(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : null;
}

function asToolPart(part: unknown): ToolPart | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  if (typeof record.type !== "string" || !record.type.startsWith("tool-")) return null;
  return part as ToolPart;
}

function ChatMessage({
  message,
  onDecision,
}: {
  message: UiMessage;
  onDecision: (toolCallId: string, approved: boolean) => void;
}) {
  const from = message.role === "user" ? "user" : "assistant";
  return (
    <Message from={from} data-cockpit-ui="chat-message">
      <MessageContent>
        {message.parts.map((part, index) => {
          const text = textFromPart(part);
          if (text)
            return <MessageResponse key={`${message.id}-text-${index}`}>{text}</MessageResponse>;
          const tool = asToolPart(part);
          if (tool) {
            const header =
              tool.type === "dynamic-tool" ? (
                <ToolHeader type={tool.type} state={tool.state} toolName={tool.toolName} />
              ) : (
                <ToolHeader type={tool.type} state={tool.state} />
              );
            return (
              <Tool
                key={`${message.id}-tool-${index}`}
                defaultOpen={tool.state !== "output-available"}
              >
                {header}
                <ToolContent>
                  <ToolInput input={tool.input} />
                  <Confirmation approval={tool.approval} state={tool.state}>
                    <ConfirmationRequest>
                      <ConfirmationTitle>
                        Review this governed action before Subkit continues.
                      </ConfirmationTitle>
                      <ConfirmationActions>
                        <ConfirmationAction
                          variant="outline"
                          onClick={() => onDecision(tool.toolCallId, false)}
                        >
                          Decline
                        </ConfirmationAction>
                        <ConfirmationAction onClick={() => onDecision(tool.toolCallId, true)}>
                          Approve
                        </ConfirmationAction>
                      </ConfirmationActions>
                    </ConfirmationRequest>
                  </Confirmation>
                  <ToolOutput output={tool.output} errorText={tool.errorText} />
                </ToolContent>
              </Tool>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(true);
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: listConversations });
  const activeId = selectedId ?? conversations.data?.items[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["conversation", activeId],
    queryFn: () => getConversation(activeId ?? ""),
    enabled: Boolean(activeId),
  });
  const send = useMutation({
    mutationFn: async (message: string) => {
      if (activeId) return appendConversationMessage(activeId, message);
      return createConversation(message);
    },
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

  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[15rem_minmax(0,1fr)_auto]"
      data-cockpit-ui="chat-workspace"
    >
      <aside className="hidden min-h-0 border-r bg-muted/20 lg:flex lg:flex-col">
        <div className="flex items-center justify-between p-3">
          <p className="text-sm font-semibold">Conversations</p>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="New conversation"
            onClick={() => setSelectedId(null)}
          >
            <MessageSquarePlus />
          </Button>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {ordered.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => setSelectedId(conversation.id)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left hover:bg-accent",
                  activeId === conversation.id && "bg-accent",
                )}
              >
                <span className="block truncate text-sm font-medium">
                  {conversation.title || "Untitled conversation"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {conversation.last_message_excerpt || conversation.status}
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-4">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {current?.title || "New conversation"}
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              {resume?.one_sentence || "Work with Subkit through governed actions."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {current && <Badge variant="outline">{current.status}</Badge>}
            {send.isPending && activeId && (
              <Button size="sm" variant="outline" onClick={() => cancel.mutate()}>
                <CircleStop /> Stop
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Toggle context"
              onClick={() => setContextOpen((open) => !open)}
            >
              {contextOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          </div>
        </header>
        {send.error && (
          <Alert variant="destructive" className="m-4 mb-0">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{send.error.message}</AlertDescription>
          </Alert>
        )}
        <ConversationViewport className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {messages.length === 0 ? (
              <ConversationEmptyState
                title="What should Subkit accomplish?"
                description="Describe the outcome. The agent can inspect, verify, preview and request approval in this workspace."
                icon={<MessageSquarePlus className="size-6" />}
              />
            ) : (
              messages.map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onDecision={(toolCallId, approved) => decide.mutate({ toolCallId, approved })}
                />
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </ConversationViewport>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          {messages.length === 0 && (
            <Suggestions className="mb-2">
              {QUICK_START.map((item) => (
                <Suggestion key={item} suggestion={item} onClick={() => send.mutate(item)} />
              ))}
            </Suggestions>
          )}
          <PromptInput
            onSubmit={async ({ text }) => {
              const trimmed = text.trim();
              if (trimmed) await send.mutateAsync(trimmed);
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea
                name="message"
                placeholder="Ask Subkit to build, run, inspect or repair…"
                disabled={send.isPending}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <span className="px-2 text-xs text-muted-foreground">Approval mode · ask</span>
              </PromptInputTools>
              <PromptInputSubmit status={status} disabled={send.isPending} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </section>

      {contextOpen && (
        <aside
          className="hidden w-72 min-h-0 border-l xl:flex xl:flex-col"
          data-cockpit-ui="context-panel"
        >
          <div className="p-4">
            <p className="text-sm font-semibold">Working context</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Evidence, checkpoints and pending decisions for this conversation.
            </p>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1">
            <dl className="space-y-4 p-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Stage</dt>
                <dd className="mt-1 font-medium">{resume?.stage || "Ready"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Target</dt>
                <dd className="mt-1 font-medium">
                  {resume?.active_target.name || resume?.active_target.kind || "None yet"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Next action</dt>
                <dd className="mt-1">{resume?.next_action || "Describe the desired outcome."}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Checkpoint</dt>
                <dd className="mt-1">
                  {resume?.unsaved ? "Unsaved changes" : "No unsaved changes"}
                </dd>
              </div>
              {resume?.pending_approval && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <dt className="text-xs font-medium">Approval required</dt>
                  <dd className="mt-1 text-xs">{resume.pending_approval.summary}</dd>
                </div>
              )}
            </dl>
          </ScrollArea>
        </aside>
      )}
    </div>
  );
}
