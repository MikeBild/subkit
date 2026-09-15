import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { List, MessageSquarePlus, PanelRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  apiRequest,
  type Conversation,
  type ConversationReference,
  cancelConversation,
  getConversation,
  listConversations,
  renameConversation,
  respondToChatApproval,
  respondToToolCall,
  sendConversationTurn,
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
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatRelativeTime, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { nameIdentifiers, type ResolvedIdentifier } from "@/lib/identifiers";
import type { DiffLine } from "@/lib/line-diff";
import { reconcileReferences } from "@/lib/mentions";
import { conversationExcerpt, hideTechnicalIdentifiers, humanFacingText } from "@/lib/presentation";
import { patchCandidateId, toolPartVerdict } from "@/lib/tool-parts";
import { isStaleCall, toolLabel, toolOutcomeKey } from "@/lib/tool-presentation";
import { cn } from "@/lib/utils";
import { useMentionCandidates } from "@/queries/mention-sources";
import { type ChatApproval, chatApproval } from "./chat-approval";
import { ChatApprovalCard } from "./chat-approval-card";
import { ConversationList } from "./chat-conversation-list";
import { applyLiveCall, elapsedMs, type LiveCall, reduceLiveCall } from "./chat-live-calls";
import { type AuthoringMode, storedAuthoringMode } from "./chat-permission";
import { collectReferencedResources, referencesFromPart } from "./chat-references";
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

/**
 * The column every region of this page shares.
 *
 * `PageFrame` states the rule for the rest of the Cockpit: a body must be
 * centred in the SAME box as its own heading, and the horizontal padding must
 * sit OUTSIDE that box in both places — put the padding on the same element as
 * the cap and the content starts one padding-width right of the title naming
 * it. Chat builds its own three regions instead of using `PageFrame`, and it
 * had drifted into three different left edges: the header at the page margin,
 * the transcript centred inside its own padding, the composer centred without
 * any. The width is the workbench width `PageFrame` gives its wide surfaces,
 * because a transcript carries tool cards, diffs and payloads, not prose alone.
 */
const COLUMN = "mx-auto w-full max-w-[1280px]";

/** Where a catalogue object lives in the Cockpit. */
function catalogHref(kind: string, id: string): string {
  const section = kind === "execution" ? "runs" : kind === "workflow" ? "workflows" : "connectors";
  return `/cockpit/${section}/${encodeURIComponent(id)}`;
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
        inputGroupClassName="h-auto min-h-12 items-stretch rounded-xl has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30"
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
            className="min-h-[46px] px-4 py-[11px] leading-6"
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
        <InputGroupAddon align="inline-end" className="self-end p-[7px] has-[>button]:mr-0">
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
  approval,
  approvalBusy,
  approvalError,
  onApproval,
  onDecision,
  nameFor,
}: {
  message: UiMessage;
  messageIndex: number;
  pendingApprovalId: string | null;
  approval: ChatApproval | null;
  approvalBusy: boolean;
  approvalError: boolean;
  onApproval: (id: string, approved: boolean) => void;
  onDecision: (toolCallId: string, approved: boolean) => void;
  /** What this conversation knows about the identifiers it mentions. */
  nameFor: (id: string) => ResolvedIdentifier | null;
}) {
  const { t, locale } = useI18n();
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
        <MessageHeader data-testid={`chat-message-${messageIndex}-role`}>
          {t(from === "user" ? "chat.role.you" : "chat.role.assistant")}
        </MessageHeader>
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
                      {nameIdentifiers(text, nameFor, t("tool.referenceHiddenInline"))}
                    </MessageResponse>
                  )}
                </BubbleContent>
              </Bubble>
            );
          }
          const tool = group.tool;
          const partIndex = group.index;
          if (approval?.toolCallId === tool.toolCallId) {
            return (
              <ChatApprovalCard
                key={`${message.id}-approval-${partIndex}`}
                approval={approval}
                busy={approvalBusy}
                error={approvalError}
                onDecision={onApproval}
                testId={`chat-message-${messageIndex}-approval`}
              />
            );
          }
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
        {from === "assistant" && (
          <MessageFooter data-testid={`chat-message-${messageIndex}-metadata`}>
            {[message.model, formatDateTime(locale, message.created_at)]
              .filter(Boolean)
              .join(" · ")}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function FollowSubmittedTurn({ submittedAt }: { submittedAt: number }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (submittedAt) scrollToEnd({ behavior: "instant" });
  }, [submittedAt, scrollToEnd]);
  return null;
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
  const [newPermissionMode, setNewPermissionMode] = useState<AuthoringMode | "default">("default");
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
  const onTurnEvent = (event: { type: string; [key: string]: unknown }) => {
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

      const params = new URLSearchParams(window.location.search);
      const workflowId = params.get("workflow_id");
      const connectorId = params.get("connector_id");
      return sendConversationTurn(
        activeId
          ? {
              conversationId: activeId,
              message,
              references,
              pendingElicitation: detail.data?.resume_summary?.pending_approval,
            }
          : {
              message,
              references,
              ...(newPermissionMode !== "default" ? { permissionMode: newPermissionMode } : {}),
              target: {
                ...(workflowId ? { workflow_id: workflowId } : {}),
                ...(connectorId ? { connector_id: connectorId } : {}),
              },
            },
        onTurnEvent,
      );
    },
    onError: async () => {
      // A rejected answer may refer to a question resolved in another tab.
      // Refresh its state; never replay the person's answer automatically.
      await queryClient.invalidateQueries({ queryKey: ["conversation", activeId] });
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
  const decisionLock = useRef(false);
  const decide = useMutation({
    mutationFn: ({
      toolCallId,
      elicitationId,
      approved,
    }: {
      toolCallId?: string;
      elicitationId?: string;
      approved: boolean;
    }) => {
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
      return elicitationId
        ? respondToChatApproval(activeId ?? "", elicitationId, approved, onTurnEvent)
        : respondToToolCall(activeId ?? "", toolCallId ?? "", approved);
    },
    onSuccess: () => {
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
    },
    onSettled: async () => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["conversations"] }),
          queryClient.invalidateQueries({ queryKey: ["conversation", activeId] }),
        ]);
      } finally {
        decisionLock.current = false;
      }
    },
  });
  const submitApproval = (elicitationId: string, approved: boolean) => {
    if (decisionLock.current || send.isPending || decide.isPending) return;
    decisionLock.current = true;
    decide.mutate({ elicitationId, approved });
  };
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
  const pendingDecision = chatApproval(detail.data);
  const createdResources = detail.data?.created_resources ?? [];
  const referencedResources = useMemo(() => collectReferencedResources(messages), [messages]);
  // Everything this conversation is known to be about: what it made, and what
  // it was pointed at. An identifier the conversation never touched stays a
  // phrase — guessing at a name from elsewhere would be worse than saying
  // nothing, because the reader cannot tell a guess from a fact.
  const nameFor = useMemo(() => {
    const known = new Map<string, ResolvedIdentifier>();
    for (const resource of createdResources) {
      const label = resource.name || resource.slug;
      if (!label) continue;
      known.set(resource.id, { label, href: catalogHref(resource.kind, resource.id) });
    }
    for (const resource of referencedResources) {
      if (resource.unresolved) continue;
      known.set(resource.id, {
        label: resource.label,
        href: catalogHref(resource.type, resource.id),
      });
    }
    const target = resume?.active_target;
    if (target?.id && (target.name || target.slug) && target.kind !== "none") {
      known.set(target.id, {
        label: (target.name || target.slug) as string,
        href: catalogHref(target.kind, target.id),
      });
    }
    return (id: string) => known.get(id) ?? null;
  }, [createdResources, referencedResources, resume?.active_target]);
  const session = useSession();
  const status = send.isPending || decide.isPending ? "streaming" : "ready";
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
    send.isPending || decide.isPending
      ? { label: t("chat.outcome.in_progress"), urgent: false }
      : resume?.pending_approval || activeRow?.outcome === "awaiting_you"
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
          className="scrollbar-thin shrink-0 overflow-y-auto border-b px-4 py-3 sm:px-6 [scrollbar-gutter:stable_both-edges]"
          data-testid="chat-header"
        >
          <div className={cn("flex items-center justify-between gap-3", COLUMN)}>
            {/* The title starts where the messages start. Controls sit on the
                other end of the same line, so the page has one left edge. */}
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
            <div className="flex shrink-0 items-center gap-1">
              {/* A badge earns its place by changing what the reader does next.
                "Waiting for you" and "In progress" do; "Answered" and "Idle"
                are the resting state and were on almost every conversation. */}
              {current && badge && (
                <Badge variant={badge.urgent ? "destructive" : "outline"} data-testid="chat-status">
                  {badge.label}
                </Badge>
              )}
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
                  setNewPermissionMode("default");
                  setChatPath(null);
                  setListOpen(false);
                }}
              >
                <MessageSquarePlus />
              </IconButton>
              <IconButton
                label={t("chat.toggleContext")}
                data-testid="chat-context-toggle"
                onClick={() => setContextOpen((open) => !open)}
              >
                <PanelRight />
              </IconButton>
            </div>
          </div>
          <div className={cn("mt-2 grid gap-1", COLUMN)} data-testid="chat-permission">
            {activeId ? (
              <p className="text-xs text-muted-foreground">
                {t("chat.mode.label")}:{" "}
                {t(`chat.mode.${detail.data ? storedAuthoringMode(detail.data.draft) : "loading"}`)}
              </p>
            ) : (
              <Select
                value={newPermissionMode}
                disabled={send.isPending}
                onValueChange={(value) => {
                  if (
                    value === "default" ||
                    value === "auto" ||
                    value === "ask" ||
                    value === "plan"
                  )
                    setNewPermissionMode(value);
                }}
              >
                <SelectTrigger
                  aria-label={t("chat.mode.label")}
                  data-testid="chat-permission-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["default", "auto", "ask", "plan"] as const).map((mode) => (
                    <SelectItem key={mode} value={mode} data-testid={`chat-permission-${mode}`}>
                      {t(`chat.mode.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">{t("chat.mode.boundary")}</p>
          </div>
        </header>

        {send.error && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-error">
            <AlertTitle>{t("chat.failed")}</AlertTitle>
            <AlertDescription>
              {t(
                send.error instanceof ApiError && send.error.code === "pending_elicitation_blocked"
                  ? "chat.pendingQuestionRequired"
                  : "chat.failedDescription",
              )}
            </AlertDescription>
          </Alert>
        )}

        {decide.isError && !pendingDecision && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-decision-error">
            <AlertDescription>{t("chat.decision.failed")}</AlertDescription>
          </Alert>
        )}
        <MessageScrollerProvider key={activeId ?? "new"} autoScroll>
          <FollowSubmittedTurn submittedAt={Math.max(send.submittedAt, decide.submittedAt)} />
          <MessageScroller className="h-0 min-h-0 flex-1" data-testid="chat-transcript">
            {/* `both-edges` is the operative part, the same as the shared page
                frame: the primitive's default utility sets plain `stable`, so
                this page-level override must win in computed style. The visual
                sweep measures the resulting three column edges on Linux. */}
            <MessageScrollerViewport
              className="px-4 py-6 sm:px-6"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              <MessageScrollerContent className={COLUMN}>
                {messages.length === 0 && !send.isPending ? (
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
                    <MessageScrollerItem key={message.id}>
                      <ChatMessage
                        message={message}
                        messageIndex={index}
                        pendingApprovalId={resume?.pending_approval?.tool_call_id ?? null}
                        approval={pendingDecision}
                        approvalBusy={send.isPending || decide.isPending}
                        approvalError={
                          decide.isError && decide.variables?.elicitationId === pendingDecision?.id
                        }
                        onApproval={submitApproval}
                        nameFor={nameFor}
                        onDecision={(toolCallId, approved) =>
                          decide.mutate({ toolCallId, approved })
                        }
                      />
                    </MessageScrollerItem>
                  ))
                )}
                {send.isPending && send.variables?.message && (
                  <MessageScrollerItem>
                    <Message align="end">
                      <MessageContent>
                        <Bubble>
                          <BubbleContent>{send.variables.message}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )}
                {liveCalls.length > 0 && (
                  <MessageScrollerItem>
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
          className="scrollbar-thin shrink-0 overflow-y-auto border-t bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 supports-[backdrop-filter]:backdrop-blur [scrollbar-gutter:stable_both-edges]"
          data-testid="chat-composer-area"
        >
          <div className={COLUMN}>
            {resume?.pending_approval?.tool_name === "ask_user_text" && !send.isPending && (
              <p className="mb-2 text-sm text-muted-foreground" data-testid="chat-reply-hint">
                {t("chat.replyHint")}
              </p>
            )}
            {(send.isPending || decide.isPending) && (
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
            <PromptInputProvider
              key={activeId ?? "new"}
              initialInput={selection.kind === "new" ? initialPrompt : ""}
            >
              <ChatComposer
                disabled={send.isPending || decide.isPending}
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
            {pendingDecision && (
              <div className="p-4 pb-0">
                <ChatApprovalCard
                  approval={pendingDecision}
                  busy={send.isPending || decide.isPending}
                  error={decide.isError && decide.variables?.elicitationId === pendingDecision?.id}
                  onDecision={submitApproval}
                  testId="chat-context-approval"
                />
              </div>
            )}
            <dl className="grid gap-4 p-4 text-sm">
              <div data-testid="chat-context-stage">
                <dt className="text-xs text-muted-foreground">{t("chat.context.stage")}</dt>
                <dd className="mt-1 font-medium">
                  {decide.isPending
                    ? t("chat.decision.processing")
                    : resumeStageLabel(resume?.stage, t)}
                </dd>
              </div>
              <div data-testid="chat-context-target">
                <dt className="text-xs text-muted-foreground">{t("chat.context.target")}</dt>
                <dd className="mt-1 font-medium">
                  {localizedTarget(resume?.active_target.name || resume?.active_target.kind, t)}
                </dd>
              </div>
              {!pendingDecision && (
                <div data-testid="chat-context-next-action">
                  <dt className="text-xs text-muted-foreground">{t("chat.context.nextAction")}</dt>
                  <dd className="mt-1">{resumeNextAction(resume?.stage, t)}</dd>
                </div>
              )}
              <div data-testid="chat-context-checkpoint">
                <dt className="text-xs text-muted-foreground">{t("chat.context.checkpoint")}</dt>
                <dd className="mt-1">
                  {t(resume?.unsaved ? "chat.context.unsaved" : "chat.context.saved")}
                </dd>
              </div>
              <div data-testid="chat-context-references">
                <dt className="text-xs text-muted-foreground">{t("chat.context.references")}</dt>
                <dd className="mt-1">
                  {referencedResources.length === 0 ? (
                    <span className="text-muted-foreground">
                      {t("chat.context.referencesEmpty")}
                    </span>
                  ) : (
                    <ul className="grid gap-1.5">
                      {referencedResources.map((resource, index) => (
                        <li
                          key={`${resource.type}-${resource.id}`}
                          className="flex min-w-0 items-center gap-2"
                          data-testid={`chat-context-reference-${index}`}
                        >
                          {resource.unresolved ? (
                            <span className="min-w-0 flex-1 truncate">{resource.label}</span>
                          ) : (
                            <a
                              className="min-w-0 flex-1 truncate underline-offset-4 hover:underline"
                              data-testid={`chat-context-reference-link-${index}`}
                              href={catalogHref(resource.type, resource.id)}
                            >
                              {resource.label}
                            </a>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t(`chat.created.kind.${resource.type}`)} ·{" "}
                            {formatRelativeTime(locale, resource.at)}
                          </span>
                          {resource.unresolved && (
                            <Badge variant="outline" className="shrink-0">
                              {t("chat.context.referenceUnavailable")}
                            </Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
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
                            href={catalogHref(resource.kind, resource.id)}
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
              {resume?.pending_approval && !pendingDecision && (
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
