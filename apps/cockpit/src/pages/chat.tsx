import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { List, MessageSquarePlus, PanelRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiRequest,
  appendConversationMessage,
  type Conversation,
  type ConversationReference,
  cancelConversation,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
  respondToToolCall,
  setConversationHidden,
  type UiMessage,
} from "@/api/client";
import { dryRunPatchCandidate, getPatchCandidatePreview } from "@/api/decisions";
import { useSession } from "@/app/session";
import { BackgroundTools } from "@/components/ai-elements/background-tools";
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
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { DiffCard } from "@/components/cockpit/diff-card";
import { IconButton } from "@/components/cockpit/icon-button";
import { MentionChips, MentionPicker, useMentionInput } from "@/components/cockpit/mention-picker";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroupAddon } from "@/components/ui/input-group";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatRelativeTime, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { DiffLine } from "@/lib/line-diff";
import { reconcileReferences } from "@/lib/mentions";
import { conversationExcerpt, hideTechnicalIdentifiers, humanFacingText } from "@/lib/presentation";
import { patchCandidateId, toolPartVerdict } from "@/lib/tool-parts";
import { isStaleCall, toolLabel, toolOutcomeKey } from "@/lib/tool-presentation";
import { useMentionCandidates } from "@/queries/mention-sources";
import { ConversationList } from "./chat-conversation-list";
import { applyLiveCall, elapsedMs, type LiveCall, reduceLiveCall } from "./chat-live-calls";
import { resumeNextAction, resumeStageLabel, resumeSummaryLine } from "./chat-resume";
import { activeConversationId, type ConversationSelection } from "./chat-selection";
import { dedupeBackground, groupMessageParts } from "./chat-transcript";

type Translate = ReturnType<typeof useI18n>["t"];

function localizedTarget(value: string | null | undefined, t: Translate): string {
  if (!value || value.toLowerCase() === "none") return t("chat.context.noTarget");
  return hideTechnicalIdentifiers(value, t("tool.referenceHiddenInline"));
}

function surfaceLabel(t: Translate, surface: string | null | undefined): string | null {
  switch (surface) {
    case "web":
      return t("chat.origin.web");
    case "sk_interactive":
      return t("chat.origin.sk_interactive");
    case "sk_headless":
      return t("chat.origin.sk_headless");
    case "mcp":
      return t("chat.origin.mcp");
    case "chat":
      return t("chat.origin.chat");
    case "api":
      return t("chat.origin.api");
    default:
      // Conversations older than the surface column have no answer here, and
      // "unknown source" is not one — it fills the line without saying
      // anything. The reader learns nothing and reads it on every row.
      return null;
  }
}

/** "Cockpit · Ada · 2 h ago" — only the parts that tell the reader something. */
export function originLine(
  t: Translate,
  locale: Parameters<typeof formatRelativeTime>[0],
  input: {
    surface?: string | null;
    owner?: { id: string; name: string } | null;
    viewerId: string | null;
    at?: string | null;
  },
): string {
  // Your own name is the one name you never need to be told.
  const who =
    input.owner && input.owner.id !== input.viewerId && input.owner.name ? input.owner.name : null;
  return [
    surfaceLabel(t, input.surface),
    who,
    input.at ? formatRelativeTime(locale, input.at) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface StreamedDiff {
  title: string;
  lines: DiffLine[];
}

const HUNK_TYPE: Record<string, DiffLine["type"]> = {
  "+": "added",
  "-": "removed",
  " ": "context",
};

/** Reads a `diff` turn event; the engine already computed the hunks. */
export function asStreamedDiff(event: {
  type: string;
  [key: string]: unknown;
}): StreamedDiff | null {
  if (event.type !== "diff" || !Array.isArray(event.hunks)) return null;
  const lines: DiffLine[] = [];
  for (const hunk of event.hunks) {
    if (!hunk || typeof hunk !== "object") continue;
    const { kind, text } = hunk as { kind?: unknown; text?: unknown };
    if (typeof text !== "string") continue;
    lines.push({ type: HUNK_TYPE[typeof kind === "string" ? kind : " "] ?? "context", text });
  }
  if (lines.length === 0) return null;
  return { title: typeof event.title === "string" ? event.title : "", lines };
}

function textFromPart(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : null;
}

function referenceList(value: unknown): ConversationReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is ConversationReference =>
      !!r &&
      typeof r === "object" &&
      typeof (r as { id?: unknown }).id === "string" &&
      typeof (r as { label?: unknown }).label === "string" &&
      ((r as { type?: unknown }).type === "workflow" ||
        (r as { type?: unknown }).type === "connector"),
  );
}

/** The @-mentions the engine stored on a user text part, if any. */
function referencesFromPart(part: unknown): {
  references: ConversationReference[];
  unresolved: ConversationReference[];
} {
  if (!part || typeof part !== "object") return { references: [], unresolved: [] };
  const record = part as Record<string, unknown>;
  return {
    references: referenceList(record.references),
    unresolved: referenceList(record.unresolved_references),
  };
}

/** The proposal is decided where it appeared, so the diff renders inside the tool card. */
function PatchProposalDiff({ candidateId, testId }: { candidateId: string; testId: string }) {
  const { t } = useI18n();
  const preview = useQuery({
    queryKey: ["patch-candidate", "preview", candidateId],
    queryFn: () => getPatchCandidatePreview(candidateId),
  });
  // Replaying needs a recorded response; without one the call only 409s.
  const dryRun = useQuery({
    queryKey: ["patch-candidate", "dry-run", candidateId],
    enabled: preview.data?.fixture_available === true,
    retry: false,
    queryFn: () => dryRunPatchCandidate(candidateId),
  });

  if (preview.isPending)
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-loading`}>
        {t("decisions.diffLoading")}
      </p>
    );
  if (preview.error || !preview.data)
    return (
      <p className="text-sm text-destructive" data-testid={`${testId}-error`}>
        {t("decisions.diffFailed")}
      </p>
    );
  return (
    <DiffCard
      testId={testId}
      embedded
      targetLabel={preview.data.proposal?.description ?? t("decisions.kind.patch")}
      before={preview.data.before_step}
      after={preview.data.after_step}
      changedPaths={preview.data.changed_paths}
      driftSummary={preview.data.drift_summary}
      patch={preview.data.proposal?.patch}
      fixtureAvailable={preview.data.fixture_available}
      dryRun={dryRun.data ?? null}
      dryRunPending={preview.data.fixture_available === true && dryRun.isPending}
    />
  );
}

const STARTERS: TranslationKey[] = ["chat.starter.capabilities", "chat.starter.lastRun"];

/** An empty chat offers the next move instead of an empty field. */
function StarterCards({
  onPick,
  disabled,
}: {
  onPick: (prompt: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const session = useSession();
  const catalog = useQuery({
    queryKey: ["chat", "starter-catalog"],
    enabled: session.permissions.includes("workflow:read"),
    queryFn: () =>
      apiRequest<{ categories: { category: string; count: number }[] }>("/v1/workflows?limit=1"),
  });
  const categories = catalog.data?.categories ?? [];

  return (
    <div className="mt-6 grid gap-3" data-testid="chat-starters">
      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS.map((key, index) => (
          <Button
            key={key}
            variant="outline"
            className="h-auto justify-start py-3 text-left whitespace-normal"
            disabled={disabled}
            data-testid={`chat-starter-${index}`}
            onClick={() => onPick(t(key))}
          >
            {t(key)}
          </Button>
        ))}
      </div>
      {categories.length > 0 && (
        <div className="grid gap-2" data-testid="chat-starter-catalog">
          <p className="text-xs text-muted-foreground">{t("chat.starter.catalog")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {categories.slice(0, 6).map((entry, index) => (
              <Button
                key={entry.category}
                variant="ghost"
                size="sm"
                disabled={disabled}
                data-testid={`chat-starter-category-${index}`}
                onClick={() =>
                  onPick(t("chat.starter.categoryPrompt", { category: entry.category }))
                }
              >
                {entry.category}
                <Badge variant="secondary" className="ml-2 tabular-nums">
                  {entry.count}
                </Badge>
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** What to call an action that gets a card of its own. `notRun` swaps the
 *  past tense for the honest form when the verdict says nothing ran. */
function actionLabel(t: Translate, toolName: string, notRun = false): string {
  const label = toolLabel(toolName);
  if (label.kind === "workflow")
    return t(notRun ? "tool.name.runNamedWorkflow.notRun" : "tool.name.runNamedWorkflow", {
      name: label.slug,
    });
  if (label.kind === "literal") return label.text;
  if (label.kind === "background") return t(label.words.past);
  if (notRun && label.key === "tool.name.runWorkflow") return t("tool.name.runWorkflow.notRun");
  return t(label.key);
}

/** A verdict under which the action did not happen. */
function didNotRun(verdict: { confirmationState: string | null; outcome: string | null }): boolean {
  return (
    verdict.outcome === "denied" ||
    verdict.confirmationState === "declined" ||
    verdict.confirmationState === "auto_declined" ||
    verdict.confirmationState === "expired"
  );
}

/** What to call a background read, in the tense that matches its state. */
function backgroundLabel(t: Translate, toolName: string, running: boolean): string {
  const label = toolLabel(toolName);
  if (label.kind === "background") return t(running ? label.words.active : label.words.past);
  return actionLabel(t, toolName);
}

/**
 * The composer with `@`-mentions. Lives inside `PromptInputProvider` so it
 * can read and write the shared text state; the references travel beside
 * the text and are reconciled against it on send (a token deleted by hand
 * drops its reference).
 */
function ChatComposer({
  disabled,
  status,
  onSend,
  onStop,
}: {
  disabled: boolean;
  status: React.ComponentProps<typeof PromptInputSubmit>["status"];
  onSend: (message: string, references: ConversationReference[]) => Promise<unknown>;
  /** Sending and stopping are one affordance: the button swaps its glyph. */
  onStop: () => void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const controller = usePromptInputController();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [references, setReferences] = useState<ConversationReference[]>([]);
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
  });
  return (
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
        onSubmit={async ({ text }) => {
          const trimmed = text.trim();
          if (!trimmed) return;
          await onSend(trimmed, reconcileReferences(trimmed, references));
          setReferences([]);
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            ref={textareaRef}
            name="message"
            placeholder={t("chat.composer.placeholder")}
            disabled={disabled}
            onKeyDown={(event) => {
              mentions.onKeyDown(event);
            }}
            onChange={(event) =>
              mentions.onChange(event.currentTarget.value, event.currentTarget.selectionStart)
            }
            onClick={(event) => mentions.onCaretMove(event.currentTarget.selectionStart)}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")
                mentions.onCaretMove(event.currentTarget.selectionStart);
            }}
            onBlur={mentions.close}
            data-testid="chat-composer-input"
          />
        </PromptInputBody>
        {/* The send control sits beside the field, not on a row of its own:
            once the approval-mode caption was gone that row held one button
            and a band of empty space taller than the field itself. */}
        <InputGroupAddon align="inline-end">
          <PromptInputSubmit
            status={status}
            onStop={onStop}
            disabled={disabled}
            aria-label={t("chat.submit")}
            tooltip={t("chat.submit")}
            data-testid="chat-composer-submit"
          />
        </InputGroupAddon>
      </PromptInput>
    </div>
  );
}

function ChatMessage({
  message,
  messageIndex,
  pendingApprovalId,
  onDecision,
}: {
  message: UiMessage;
  messageIndex: number;
  pendingApprovalId: string | null;
  onDecision: (toolCallId: string, approved: boolean) => void;
}) {
  const { t } = useI18n();
  const from = message.role === "user" ? "user" : "assistant";
  // Both roles get the same column: a dark bubble on the right made the
  // reader's own words the loudest thing on the page and cut the usable width
  // of every question to 80%. Who spoke is a label, not a shape.
  return (
    <Message
      align="start"
      data-cockpit-ui="chat-message"
      data-testid={`chat-message-${messageIndex}`}
    >
      <MessageContent data-testid={`chat-message-${messageIndex}-content`}>
        <span
          className="text-xs font-medium text-muted-foreground"
          data-testid={`chat-message-${messageIndex}-role`}
        >
          {t(from === "user" ? "chat.role.you" : "chat.role.assistant")}
        </span>
        {groupMessageParts(message.parts, pendingApprovalId).map((group) => {
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
            const text = textFromPart(group.part);
            if (!text) return null;
            const mentions = from === "user" ? referencesFromPart(group.part) : null;
            return (
              <Bubble key={`${message.id}-text-${group.index}`} variant="ghost" align="start">
                <BubbleContent data-testid={`chat-message-${messageIndex}-text-${group.index}`}>
                  {mentions && mentions.references.length > 0 ? (
                    <MentionChips
                      text={text}
                      references={mentions.references}
                      unresolved={mentions.unresolved}
                      hiddenLabel={t("tool.referenceHiddenInline")}
                      testIdPrefix={`chat-message-${messageIndex}-text-${group.index}`}
                    />
                  ) : (
                    <MessageResponse>
                      {hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline"))}
                    </MessageResponse>
                  )}
                </BubbleContent>
              </Bubble>
            );
          }
          const tool = group.tool;
          const partIndex = group.index;
          const candidateId = patchCandidateId(tool);
          const verdict = toolPartVerdict(tool);
          const stale = isStaleCall({
            messageCreatedAt: message.created_at,
            hasResult: tool.state === "output-available" || tool.state === "output-error",
            isStreaming: false,
            now: Date.now(),
          });
          const outcomeKey = toolOutcomeKey({
            confirmationState: verdict.confirmationState,
            outcome: verdict.outcome,
            stale,
          });
          const notRun = didNotRun(verdict);
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
                  title={actionLabel(t, tool.toolName, notRun)}
                  outcomeKey={outcomeKey}
                  data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
                />
              ) : (
                <ToolHeader
                  type={tool.type}
                  state={tool.state}
                  title={actionLabel(t, tool.type.replace(/^tool-/, ""), notRun)}
                  outcomeKey={outcomeKey}
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
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const initialPrompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
  const [selection, setSelection] = useState<ConversationSelection>(() =>
    selectionFromPath(initialPrompt),
  );
  const [showHidden, setShowHidden] = useState(false);
  const [conversationSearch, setConversationSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [streamedText, setStreamedText] = useState("");
  const [streamedDiffs, setStreamedDiffs] = useState<StreamedDiff[]>([]);
  // The engine has always streamed `tool_call_start`, `tool_log` and
  // `tool_call_end`; the page dropped every frame but `text_delta` and `diff`,
  // so a long-running action showed nothing at all while it worked.
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
  const [liveTick, setLiveTick] = useState(0);
  const anyLive = liveCalls.some((call) => !call.done);
  useEffect(() => {
    if (!anyLive) return;
    // One timer for the page, not one per card.
    const timer = setInterval(() => setLiveTick((tick) => tick + 1), 250);
    return () => clearInterval(timer);
  }, [anyLive]);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    const onPopState = () => {
      const prompt = new URLSearchParams(window.location.search).get("prompt") ?? "";
      setSelection(selectionFromPath(prompt));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(conversationSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [conversationSearch]);
  const conversations = useQuery({
    queryKey: ["conversations", debouncedSearch, showHidden ? "hidden" : "visible"],
    queryFn: () => listConversations(debouncedSearch, showHidden ? { hidden: "only" } : {}),
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
    mutationFn: async ({
      message,
      references,
    }: {
      message: string;
      references?: ConversationReference[];
    }) => {
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        if (event.type === "text_delta" && typeof event.text === "string") {
          setStreamedText((currentText) => currentText + event.text);
          return;
        }
        const live = reduceLiveCall(event);
        if (live) {
          setLiveCalls((calls) => applyLiveCall(calls, live));
          return;
        }
        // A change the engine proposes mid-turn: show it while it is being
        // worked out, not only once the turn ends and the state refetches.
        const diff = asStreamedDiff(event);
        if (diff) setStreamedDiffs((current) => [...current, diff]);
      };
      if (activeId) return appendConversationMessage(activeId, message, onEvent, references);
      const params = new URLSearchParams(window.location.search);
      const workflowId = params.get("workflow_id");
      const connectorId = params.get("connector_id");
      return createConversation(
        message,
        onEvent,
        {
          ...(workflowId ? { workflow_id: workflowId } : {}),
          ...(connectorId ? { connector_id: connectorId } : {}),
        },
        references,
      );
    },
    onSuccess: async (result) => {
      setSelection({ kind: "existing", id: result.conversation.id });
      setChatPath(result.conversation.id, true);
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
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
  const hide = useMutation({
    mutationFn: ({ id, hidden }: { id: string; hidden: boolean }) =>
      setConversationHidden(id, hidden),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
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
  const createdResources = detail.data?.created_resources ?? [];
  const session = useSession();
  const status = send.isPending ? "streaming" : send.isError ? "error" : "ready";
  const ordered = useMemo(
    () =>
      [...(conversations.data?.items ?? [])].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      ),
    [conversations.data],
  );
  // The row the header reads outcome and activity from: the list carries the
  // read-time projection, the detail does not.
  const activeRow = ordered.find((conversation) => conversation.id === activeId) ?? null;
  const origin = current
    ? originLine(t, locale, {
        surface: current.surface,
        owner: detail.data?.owner ?? null,
        viewerId: session.principal.id ?? null,
        at: activeRow?.last_activity_at ?? current.updated_at,
      })
    : "";
  // Only an outcome the reader can act on gets a chip; the rest is the
  // resting state and the row already carries it.
  const badge =
    activeRow?.outcome === "awaiting_you"
      ? { label: t("chat.outcome.awaiting_you"), urgent: true }
      : activeRow?.outcome === "in_progress" || (!activeRow && current?.status === "active")
        ? { label: t("chat.outcome.in_progress"), urgent: false }
        : null;
  // Titles are prose the model wrote: internal references never reach a row.
  const listRows = useMemo(
    () =>
      ordered.map((conversation) => ({
        ...conversation,
        title: conversation.title
          ? humanFacingText(conversation.title, t("tool.referenceHidden"))
          : conversation.title,
      })),
    [ordered, t],
  );
  const list = (
    <ConversationList
      conversations={listRows}
      activeId={activeId}
      showHidden={showHidden}
      onToggleHidden={() => setShowHidden((value) => !value)}
      onHide={(conversation, hidden) => hide.mutate({ id: conversation.id, hidden })}
      onSelect={(id) => {
        setSelection({ kind: "existing", id });
        setChatPath(id);
        setListOpen(false);
      }}
      search={conversationSearch}
      onSearchChange={setConversationSearch}
      onRename={(conversation) => {
        setRenameTarget(conversation);
        setRenameTitle(conversation.title || t("chat.untitled"));
      }}
      labelsFor={(conversation) => ({
        untitled: t("chat.untitled"),
        excerpt:
          conversationExcerpt(
            conversation.last_message_excerpt,
            t("chat.toolActivity"),
            t("tool.referenceHidden"),
            (toolName) => actionLabel(t, toolName),
          ) || null,
      })}
    />
  );

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      data-cockpit-ui="chat-workspace"
      data-testid="chat-workspace"
    >
      {/* The list is a way back in, not a permanent neighbour: it opens on
          demand at every width, and the conversation keeps the whole page.
          A reader who is reading one conversation is not choosing another. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chat-main">
        <header
          className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2"
          data-testid="chat-header"
        >
          <div className="flex min-w-0 items-center gap-2">
            <IconButton
              label={t("chat.conversations.open")}
              data-testid="conversation-list-trigger"
              onClick={() => setListOpen(true)}
            >
              <List />
            </IconButton>
            {/* "New" is a reset to the empty state, not a form: the composer
                and the starter cards are the way in. */}
            <IconButton
              label={t("chat.new")}
              data-testid="conversation-new"
              onClick={() => {
                setSelection({ kind: "new" });
                setChatPath(null);
                setListOpen(false);
              }}
            >
              <MessageSquarePlus />
            </IconButton>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold" data-testid="chat-title">
                {current?.title || t("chat.new")}
              </h1>
              <p className="truncate text-xs text-muted-foreground" data-testid="chat-summary">
                {resumeSummaryLine(resume, t)}
              </p>
              {/* Where it came from, whose it is, when it last moved — beside
                  the summary, not instead of it (§5 keeps the summary line). */}
              {current && origin && (
                <p className="truncate text-xs text-muted-foreground" data-testid="chat-origin">
                  {origin}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* A badge earns its place by changing what the reader does next.
                "Waiting for you" and "In progress" do; "Answered" and "Idle"
                are the resting state and were on almost every conversation. */}
            {current && badge && (
              <Badge variant={badge.urgent ? "destructive" : "outline"} data-testid="chat-status">
                {badge.label}
              </Badge>
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
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-5 py-6 sm:px-8">
                {messages.length === 0 ? (
                  // `place-items-center` on a box taller than the scroller splits
                  // the overflow between top and bottom, and the top half is
                  // clipped — which is where the icon sat. `m-auto` centres the
                  // same way while keeping the whole block below the top edge.
                  <div className="flex flex-1 py-10 text-center" data-testid="chat-empty">
                    <div className="m-auto max-w-2xl">
                      <span className="mx-auto grid size-10 place-items-center rounded-full bg-muted">
                        <MessageSquarePlus />
                      </span>
                      <h2 className="mt-4 font-semibold">{t("chat.empty.title")}</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("chat.empty.description")}
                      </p>
                      <StarterCards
                        onPick={(prompt) => send.mutate({ message: prompt })}
                        disabled={send.isPending}
                      />
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
                        pendingApprovalId={resume?.pending_approval?.id ?? null}
                        onDecision={(toolCallId, approved) =>
                          decide.mutate({ toolCallId, approved })
                        }
                      />
                    </MessageScrollerItem>
                  ))
                )}
                {liveCalls.length > 0 && (
                  <MessageScrollerItem scrollAnchor={!streamedText && streamedDiffs.length === 0}>
                    {/* `liveTick` is the render trigger: the interval bumps it so
                        the ages below re-read the clock. Reading it here is what
                        makes that dependency visible instead of incidental. */}
                    <div className="grid gap-1" data-testid="chat-live-calls" data-tick={liveTick}>
                      {liveCalls.map((call, index) => {
                        const running = elapsedMs(call, Date.now());
                        return (
                          <div
                            key={call.callId}
                            className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground"
                            data-testid={`chat-live-call-${index}`}
                          >
                            <span className="font-medium">
                              {call.toolName ? actionLabel(t, call.toolName) : t("tool.action")}
                            </span>
                            {call.logTail && (
                              <span className="min-w-0 truncate">{call.logTail}</span>
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
                  <MessageScrollerItem scrollAnchor={!streamedText}>
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
            {/* One name, not two: the caption below IS the accessible name, so
                an aria-label beside it would be a second source for one fact. */}
            <MessageScrollerButton
              direction="end"
              label={t("chat.scrollBottom")}
              data-testid="chat-scroll-bottom"
            />
          </MessageScroller>
        </MessageScrollerProvider>

        <div
          className="shrink-0 border-t bg-background/95 px-4 py-3 supports-[backdrop-filter]:backdrop-blur"
          data-testid="chat-composer-area"
        >
          <div className="mx-auto w-full max-w-3xl">
            <PromptInputProvider
              key={activeId ?? "new"}
              initialInput={selection.kind === "new" ? initialPrompt : ""}
            >
              <ChatComposer
                disabled={send.isPending}
                status={status}
                onStop={() => cancel.mutate()}
                onSend={(message, references) => send.mutateAsync({ message, references })}
              />
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
                <dd className="mt-1 font-medium">{resumeStageLabel(resume?.stage, t)}</dd>
              </div>
              <div data-testid="chat-context-target">
                <dt className="text-xs text-muted-foreground">{t("chat.context.target")}</dt>
                <dd className="mt-1 font-medium">
                  {localizedTarget(resume?.active_target.name || resume?.active_target.kind, t)}
                </dd>
              </div>
              <div data-testid="chat-context-next-action">
                <dt className="text-xs text-muted-foreground">{t("chat.context.nextAction")}</dt>
                <dd className="mt-1">{resumeNextAction(resume?.stage, t)}</dd>
              </div>
              <div data-testid="chat-context-checkpoint">
                <dt className="text-xs text-muted-foreground">{t("chat.context.checkpoint")}</dt>
                <dd className="mt-1">
                  {t(resume?.unsaved ? "chat.context.unsaved" : "chat.context.saved")}
                </dd>
              </div>
              <div data-testid="chat-context-created">
                <dt className="text-xs text-muted-foreground">{t("chat.created.title")}</dt>
                <dd className="mt-1">
                  {createdResources.length === 0 ? (
                    <span className="text-muted-foreground">{t("chat.created.empty")}</span>
                  ) : (
                    <ul className="grid gap-1">
                      {createdResources.map((resource, index) => (
                        <li
                          key={`${resource.kind}-${resource.id}`}
                          className="flex items-baseline gap-2"
                        >
                          <a
                            className="truncate underline-offset-4 hover:underline"
                            href={`/cockpit/${resource.kind === "execution" ? "runs" : resource.kind === "workflow" ? "workflows" : "connectors"}/${encodeURIComponent(resource.id)}`}
                            data-testid={`chat-context-created-${index}`}
                          >
                            {resource.name ||
                              resource.slug ||
                              t(`chat.created.kind.${resource.kind}`)}
                          </a>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t(`chat.created.kind.${resource.kind}`)} ·{" "}
                            {formatRelativeTime(locale, resource.at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
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
              {/* The engine's own sentence is kept, one disclosure deep: it is
                  the evidence behind the German line above, and throwing it
                  away would make a wrong line unarguable. It is not the line
                  itself — nobody reads the working context in another language
                  by accident. */}
              {resume?.one_sentence && (
                <details
                  className="text-xs text-muted-foreground"
                  data-testid="chat-context-engine-wording"
                >
                  <summary className="cursor-pointer select-none">
                    {t("chat.resume.engineWording")}
                  </summary>
                  <p className="mt-2">
                    {hideTechnicalIdentifiers(resume.one_sentence, t("tool.referenceHiddenInline"))}
                  </p>
                </details>
              )}
            </dl>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent
          side="left"
          className="w-80 p-0"
          closeLabel={t("chat.conversations.close")}
          closeTestId="conversation-list-close"
          data-testid="conversation-list-panel"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("chat.conversations")}</SheetTitle>
          </SheetHeader>
          {list}
        </SheetContent>
      </Sheet>

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
