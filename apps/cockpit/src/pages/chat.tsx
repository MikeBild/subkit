import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, List, MessageSquarePlus, PanelRight } from "lucide-react";
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ApiError,
  apiRequest,
  type Conversation,
  type ConversationDetail,
  type ConversationReference,
  cancelConversation,
  getConversation,
  listConversations,
  renameConversation,
  respondToChatApproval,
  respondToChatChoice,
  respondToChatForm,
  respondToChatText,
  respondToToolCall,
  sendConversationTurn,
  setConversationHidden,
  type UiMessage,
} from "@/api/client";
import { dryRunPatchCandidate, getPatchCandidatePreview } from "@/api/decisions";
import {
  absolute,
  chatNewHref,
  chatSeedFromUrl,
  connectorHref,
  conversationHref,
  runHref,
  usageHref,
  workflowHref,
} from "@/app/links";
import { useSession } from "@/app/session";
import { CHAT_COLUMN, useChatHeaderSlot } from "@/app/shell-header";
import { useHeldSchedules } from "@/app/use-decisions";
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
import { AutomationGrant, AutomationToolCard } from "@/components/cockpit/automation-grant";
import { DiffCard } from "@/components/cockpit/diff-card";
import { IconButton } from "@/components/cockpit/icon-button";
import { MentionChips, MentionPicker, useMentionInput } from "@/components/cockpit/mention-picker";
import { LoadFailed, queryView } from "@/components/failure-state";
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { categoryMentionToken, reconcileReferences } from "@/lib/mentions";
import { resolveWorkflowNameBySlug } from "@/lib/name-index";
import { conversationExcerpt, hideTechnicalIdentifiers, humanFacingText } from "@/lib/presentation";
import { patchCandidateId, toolNameOf, toolPartVerdict } from "@/lib/tool-parts";
import {
  isStaleCall,
  isWorkflowRunTool,
  toolLabel,
  toolOutcomeKey,
  type WorkflowRunKind,
  workflowRefusalKey,
  workflowRunKind,
  workflowRunTitleKey,
} from "@/lib/tool-presentation";
import { cn } from "@/lib/utils";
import { useMentionCandidates, useWorkflowCategories } from "@/queries/mention-sources";
import { type ChatApproval, chatApproval } from "./chat-approval";
import { ChatApprovalCard } from "./chat-approval-card";
import { chatAutomationTool } from "./chat-automation-tool";
import { type ChatChoice, chatChoice } from "./chat-choice";
import { ChatChoiceCard } from "./chat-choice-card";
import { ConversationList } from "./chat-conversation-list";
import { type ChatForm, chatForm } from "./chat-form";
import { ChatFormCard } from "./chat-form-card";
import { applyLiveCall, elapsedMs, type LiveCall, reduceLiveCall } from "./chat-live-calls";
import { conversationFailureKind, retryConversationRead } from "./chat-load-failure";
import { CHAT_MARKDOWN_COMPONENTS } from "./chat-message-link";
import {
  AUTHORING_MODES,
  DEFAULT_AUTHORING_MODE,
  modeDescriptionKey,
  modeGates,
  modeLabelKey,
  modeSuffixKey,
} from "./chat-mode";
import { type AuthoringMode, storedAuthoringMode } from "./chat-permission";
import { type ChatReauth, chatReauth } from "./chat-reauth";
import { ChatReauthCard } from "./chat-reauth-card";
import { collectReferencedResources, referencesFromPart } from "./chat-references";
import { resumeNextAction, resumeStageLabel, resumeSummaryLine } from "./chat-resume";
import {
  activeConversationId,
  type ConversationSelection,
  pinSelectionForSend,
} from "./chat-selection";
import {
  budgetPill,
  type ChatNavigation,
  chatHeaderTitle,
  conversationOpenedByFailedSend,
  costPill,
  nextSessionKey,
  type OptimisticMessage,
  optimisticUiMessage,
  optimisticVisible,
  recoverFailedSend,
  tokenPill,
  turnFailureCause,
  userMessageCount,
} from "./chat-session";
import { type ChatText, chatText, questionExcerpt, questionIsInTranscript } from "./chat-text";
import { ChatTextCard } from "./chat-text-card";
import { dedupeBackground, groupMessageParts } from "./chat-transcript";
import { budgetPressure, budgetSummary } from "./usage-model";

type Translate = ReturnType<typeof useI18n>["t"];
type ConversationUsage = ConversationDetail["usage"];

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
const COLUMN = CHAT_COLUMN;

/** Where a catalogue object lives in the Cockpit. */
function catalogHref(kind: string, id: string): string {
  // A run has its own address now (`RUN_ROUTES` in app/route-table.ts). This
  // used to return the bare list, correctly, because `/runs/<id>` resolved to
  // nothing and every run a conversation named landed on "page not found" —
  // and the comment here said so. The route exists, so the comment was the
  // thing that went stale, and a reader following a run out of a transcript
  // would still have arrived at a list of eleven thousand.
  if (kind === "execution") return absolute(runHref(id));
  return absolute(kind === "workflow" ? workflowHref(id) : connectorHref(id));
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
  const { categories } = useWorkflowCategories(session.permissions.includes("workflow:read"));

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
                // The chip says what the `@` picker says: the same token, which
                // the engine answers from the catalog without a model turn.
                onClick={() =>
                  onPick(
                    t("chat.starter.categoryPrompt", {
                      token: categoryMentionToken(entry.category),
                    }),
                  )
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
 *  past tense for the honest form when the verdict says nothing ran, and
 *  `run` says what a workflow call really was — a run, a trial, a refusal. */
function actionLabel(
  t: Translate,
  toolName: string,
  notRun = false,
  workflowNameFor: (slug: string) => string | null = () => null,
  run: WorkflowRunKind | null = null,
): string {
  const label = toolLabel(toolName);
  if (label.kind === "literal") return label.text;
  if (label.kind === "background") return t(label.words.past);
  const runTitle = workflowRunTitleKey(label, notRun, run);
  // The name its author gave it when there is one; the slug otherwise. The
  // slug is never dressed up — see `toolLabel`.
  const name = label.kind === "workflow" ? (workflowNameFor(label.slug) ?? label.slug) : "";
  if (runTitle) return t(runTitle, { name });
  return label.kind === "key" ? t(label.key) : name;
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

type RestoreComposer = (text: string, references: ConversationReference[]) => void;

/**
 * The composer with `@`-mentions. Lives inside `PromptInputProvider` so it
 * can read and write the shared text state; the references travel beside
 * the text and are reconciled against it on send (a token deleted by hand
 * drops its reference).
 */
function ChatComposer({
  disabled,
  status,
  placeholder,
  describedBy,
  onSend,
  onStop,
  restoreRef,
}: {
  disabled: boolean;
  status: React.ComponentProps<typeof PromptInputSubmit>["status"];
  placeholder: string;
  /** The id of a hint that says where the answer goes, when one is shown. */
  describedBy?: string;
  /** Resolves true when the request was sent, false when it was handed back. */
  onSend: (message: string, references: ConversationReference[]) => Promise<boolean>;
  /** Sending and stopping are one affordance: the button swaps its glyph. */
  onStop: () => void;
  /** Where the page hands a request back that the engine did not keep. */
  restoreRef: MutableRefObject<RestoreComposer | null>;
}) {
  const { t } = useI18n();
  const session = useSession();
  const controller = usePromptInputController();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [references, setReferences] = useState<ConversationReference[]>([]);
  const setInput = controller.textInput.setInput;
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
  });
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
            inputGroupClassName="h-auto min-h-12 items-stretch rounded-xl has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30"
            onSubmit={async ({ text }) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              // The request leaves the field the moment it is sent: it stands in
              // the transcript now, and a second copy in the field reads as unsent.
              const sent = reconcileReferences(trimmed, references);
              controller.textInput.clear();
              setReferences([]);
              // Handed back: the page has put the text back into the field. The
              // prompt input clears the field after a submit that resolves, so this
              // one must not resolve.
              if (!(await onSend(trimmed, sent))) throw new Error("request handed back");
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea
                ref={textareaRef}
                name="message"
                className="min-h-[46px] px-4 py-[11px] leading-6"
                placeholder={placeholder}
                aria-describedby={describedBy}
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
      </PopoverAnchor>
    </Popover>
  );
}

/**
 * What a mode still asks about and what it lets through (§14).
 *
 * A mode's name says nothing about its gates; two names over one matrix are a
 * reading trap. The rows come from the engine's enforcement table
 * (`chat-mode.ts`), and a mode whose difference is only an instruction to the
 * model says so — a Leitplanke, not a Grenze.
 */
function ModeGateMatrix({ mode }: { mode: AuthoringMode }) {
  const { t } = useI18n();
  const gates = modeGates(mode);
  return (
    <div className="grid gap-0.5 text-xs text-muted-foreground" data-testid="chat-mode-gates">
      <p data-testid="chat-mode-gates-asks">
        <span className="font-medium text-foreground">{t("chat.mode.asks")}</span>{" "}
        {gates.asks.map((key) => t(key)).join(" · ")}
      </p>
      {gates.free.length > 0 ? (
        <p data-testid="chat-mode-gates-free">
          <span className="font-medium text-foreground">{t("chat.mode.free")}</span>{" "}
          {gates.free.map((key) => t(key)).join(" · ")}
        </p>
      ) : null}
      <p data-testid="chat-mode-gates-outside">
        <span className="font-medium text-foreground">{t("chat.mode.outside")}</span>{" "}
        {gates.outside.map((key) => t(key)).join(" ")}
      </p>
      {gates.guidance ? <p data-testid="chat-mode-guidance">{t(gates.guidance)}</p> : null}
    </div>
  );
}

/**
 * The mode as a pill in the header.
 *
 * The whole gate matrix used to stand under the picker on every conversation,
 * three lines of rules read once and then skipped. The pill names the mode in
 * a word; the open list says in one line per option what it changes; the
 * matrix (§14) is one click away behind "Was heißt das?" — at the picker,
 * where the convention wants it, but not in the reader's way. A running
 * conversation shows the same pill, read-only: its mode is fixed.
 */
function ModePill({
  mode,
  label,
  editable,
  disabled,
  onChange,
}: {
  /** The mode whose matrix the popover states; null for one it cannot state. */
  mode: AuthoringMode | null;
  label: string;
  editable: boolean;
  disabled: boolean;
  onChange: (mode: AuthoringMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-0.5" data-testid="chat-permission">
      {editable && mode ? (
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(value) => {
            const next = AUTHORING_MODES.find((candidate) => candidate === value);
            if (next) onChange(next);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("chat.mode.label")}
            className="h-6 rounded-full px-2.5 text-xs"
            data-testid="chat-permission-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start" className="w-72">
            {AUTHORING_MODES.map((option) => {
              const suffix = modeSuffixKey(option);
              return (
                <SelectItem
                  key={option}
                  value={option}
                  data-testid={`chat-permission-${option}`}
                  suffix={suffix ? t(suffix) : undefined}
                  description={t(modeDescriptionKey(option))}
                >
                  {t(modeLabelKey(option))}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <span
          className="inline-flex h-6 items-center rounded-full border px-2.5 text-xs"
          data-testid="chat-permission-mode"
        >
          <span className="sr-only">{t("chat.mode.label")}: </span>
          {label}
        </span>
      )}
      {mode ? (
        <Popover>
          <PopoverTrigger asChild>
            <IconButton
              label={t("chat.mode.explain")}
              size="icon-xs"
              data-testid="chat-mode-explain"
            >
              <Info />
            </IconButton>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80" data-testid="chat-mode-explain-content">
            <p className="mb-2 text-sm font-medium">{t("chat.mode.explain")}</p>
            <ModeGateMatrix mode={mode} />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/** Numbers and money in the header's pills, in the reader's locale. */
function UsagePills({
  usage,
  budget,
}: {
  usage: ConversationUsage | null | undefined;
  budget: "tightening" | "critical" | null;
}) {
  const { t, locale } = useI18n();
  const tokens = tokenPill(usage);
  const cost = costPill(usage);
  const pill =
    "inline-flex h-6 items-center rounded-full border px-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap";
  return (
    <>
      {tokens !== null && (
        <span
          className={pill}
          data-testid="chat-usage-tokens"
          title={t("chat.usage.tokensTitle", {
            models: (usage?.by_model ?? [])
              .map((row) => `${row.model} ${new Intl.NumberFormat(locale).format(row.tokens)}`)
              .join(" · "),
          })}
        >
          {t("chat.usage.tokens", { tokens: new Intl.NumberFormat(locale).format(tokens) })}
        </span>
      )}
      {cost && (
        <span
          className={pill}
          data-testid="chat-usage-cost"
          data-floor={cost.floor || undefined}
          title={
            cost.floor
              ? t("chat.usage.costFloorTitle", {
                  models: (usage?.cost?.unpriced_models ?? []).join(", "),
                })
              : t("chat.usage.costTitle")
          }
        >
          {cost.floor ? `${t("overview.operations.atLeast")} ` : ""}
          {new Intl.NumberFormat(locale, {
            style: "currency",
            currency: cost.currency,
            maximumFractionDigits: cost.amount < 1 ? 4 : 2,
          }).format(cost.amount)}
        </span>
      )}
      {budget && (
        // A warning with its way to the cause: Nutzung carries the month.
        <Badge
          asChild
          variant={budget === "critical" ? "destructive" : "outline"}
          className={cn(
            "h-6 rounded-full px-2.5",
            budget === "tightening" && "border-warning/40 bg-warning/10 text-warning",
          )}
        >
          <a href={absolute(usageHref())} data-testid="chat-budget" data-budget={budget}>
            {t(budget === "critical" ? "chat.budget.critical" : "chat.budget.tightening")}
          </a>
        </Badge>
      )}
    </>
  );
}

function ChatMessage({
  message,
  messageIndex,
  pendingApprovalId,
  approval,
  choice,
  form,
  text = null,
  onForm,
  onChoice,
  onText = () => {},
  answersQuestion = false,
  approvalBusy,
  approvalError,
  onApproval,
  onDecision,
  onReauth,
  onAutomationAdjust,
  nameFor,
  workflowNameFor,
}: {
  message: UiMessage;
  messageIndex: number;
  pendingApprovalId: string | null;
  approval: ChatApproval | null;
  choice: ChatChoice | null;
  form: ChatForm | null;
  /** The pending free-text question; its card replaces its tool row. */
  text?: ChatText | null;
  onForm: (id: string, output: Record<string, unknown>) => void;
  onChoice: (id: string, value: string) => void;
  onText?: (id: string, value: string) => void;
  /** This user message is the answer to a text question, not a new request. */
  answersQuestion?: boolean;
  approvalBusy: boolean;
  approvalError: boolean;
  onApproval: (id: string, approved: boolean) => void;
  onDecision: (toolCallId: string, approved: boolean) => void;
  onReauth: (action: ChatReauth) => void;
  onAutomationAdjust: (workflowId: string) => void;
  /** What this conversation knows about the identifiers it mentions. */
  nameFor: (id: string) => ResolvedIdentifier | null;
  /** The workflow's own name for a `wf_<slug>` action, or null to keep the
   *  slug. Resolving what this conversation actually ran is a lookup, not the
   *  guessing the comment above rules out. */
  workflowNameFor: (slug: string) => string | null;
}) {
  const { t, locale } = useI18n();
  const from = message.role === "user" ? "user" : "assistant";
  const groups = groupMessageParts(message.parts, pendingApprovalId).filter(
    (group) => group.kind !== "part" || Boolean(textFromPart(group.part)?.trim()),
  );
  if (groups.length === 0) return null;
  // Keep the shared reading column; a soft question tone distinguishes user input.
  return (
    <Message
      align="start"
      data-cockpit-ui="chat-message"
      data-testid={`chat-message-${messageIndex}`}
    >
      <MessageContent data-testid={`chat-message-${messageIndex}-content`}>
        <MessageHeader data-testid={`chat-message-${messageIndex}-role`}>
          {t(from === "user" ? "chat.role.you" : "chat.role.assistant")}
          {answersQuestion ? (
            <span
              className="ml-1 font-normal text-muted-foreground"
              data-testid={`chat-message-${messageIndex}-answer-to`}
            >
              · {t("chat.text.answerTo")}
            </span>
          ) : null}
        </MessageHeader>
        {groups.map((group) => {
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
              <Bubble
                key={`${message.id}-text-${group.index}`}
                variant={from === "user" ? "question" : "ghost"}
                align="start"
              >
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
                    <MessageResponse components={CHAT_MARKDOWN_COMPONENTS}>
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
          if (form?.toolCallId === tool.toolCallId)
            return (
              <ChatFormCard
                key={`${message.id}-form-${partIndex}`}
                form={form}
                busy={approvalBusy}
                error={approvalError}
                onAnswer={onForm}
                testId={`chat-message-${messageIndex}-form`}
              />
            );
          if (text?.toolCallId === tool.toolCallId)
            return (
              <ChatTextCard
                key={`${message.id}-text-question-${partIndex}`}
                text={text}
                busy={approvalBusy}
                error={approvalError}
                onAnswer={onText}
                testId={`chat-message-${messageIndex}-text-question`}
              />
            );
          if (choice?.toolCallId === tool.toolCallId) {
            return (
              <ChatChoiceCard
                key={`${message.id}-choice-${partIndex}`}
                choice={choice}
                busy={approvalBusy}
                error={approvalError}
                onAnswer={onChoice}
                testId={`chat-message-${messageIndex}-choice`}
              />
            );
          }
          const automation = chatAutomationTool(tool);
          if (automation && automation.environments.length > 0)
            return (
              <AutomationToolCard
                key={`${message.id}-automation-${partIndex}`}
                tool={tool}
                onAdjust={onAutomationAdjust}
              />
            );
          const reauth = chatReauth(tool, window.location.origin);
          if (reauth)
            return (
              <ChatReauthCard
                key={`${message.id}-reauth-${partIndex}`}
                action={reauth}
                connectorName={nameFor(reauth.connectorId)?.label || reauth.label || null}
                pending={Boolean(approval || choice || form)}
                busy={approvalBusy}
                onRenew={onReauth}
              />
            );
          const candidateId = patchCandidateId(tool);
          const verdict = toolPartVerdict(tool);
          const stale = isStaleCall({
            messageCreatedAt: message.created_at,
            hasResult:
              tool.state === "output-available" ||
              tool.state === "output-error" ||
              tool.state === "output-denied",
            isStreaming: false,
            now: Date.now(),
          });
          const answeredQuestion =
            tool.type === "dynamic-tool" &&
            (tool.toolName === "ask_user_choice" ||
              tool.toolName === "ask_user_text" ||
              tool.toolName === "ask_user_form") &&
            verdict.outcome === "ok";
          const choiceStatus =
            tool.type === "dynamic-tool"
              ? (tool.output as { status?: string } | undefined)?.status
              : null;
          const outcomeKey =
            choiceStatus === "timeout"
              ? "chat.choice.expired"
              : choiceStatus === "cancelled"
                ? "chat.choice.cancelled"
                : answeredQuestion
                  ? "chat.outcome.answered"
                  : toolOutcomeKey({
                      confirmationState: verdict.confirmationState,
                      outcome: verdict.outcome,
                      stale,
                    });
          const notRun = didNotRun(verdict);
          // A workflow call says what it was: a run, a trial that sent
          // nothing, or a refusal with the engine's reason beside it.
          const runKind =
            notRun || !isWorkflowRunTool(toolNameOf(tool)) ? null : workflowRunKind(tool.output);
          const refusalKey = runKind === "refused" ? workflowRefusalKey(tool.output) : null;
          const headerOutcomeKey = refusalKey ?? outcomeKey;
          // An answered text question stays readable: the question is what
          // the next message (marked as its answer) replies to.
          const askedQuestion =
            tool.type === "dynamic-tool" && tool.toolName === "ask_user_text"
              ? (tool.input as { question?: unknown } | undefined)?.question
              : undefined;
          if (typeof askedQuestion === "string" && askedQuestion.trim() && outcomeKey !== null)
            return (
              <div
                key={`${message.id}-asked-${partIndex}`}
                className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
                data-testid={`chat-message-${messageIndex}-asked-${partIndex}`}
              >
                <p className="text-xs text-muted-foreground">
                  {t("chat.text.answeredQuestion")} · {t(outcomeKey)}
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {hideTechnicalIdentifiers(askedQuestion, t("tool.referenceHiddenInline"))}
                </p>
              </div>
            );
          return (
            <Tool
              key={`${message.id}-tool-${partIndex}`}
              defaultOpen={false}
              data-testid={`chat-message-${messageIndex}-tool-${partIndex}`}
            >
              {tool.type === "dynamic-tool" ? (
                <ToolHeader
                  type={tool.type}
                  state={tool.state}
                  toolName={tool.toolName}
                  title={actionLabel(t, tool.toolName, notRun, workflowNameFor, runKind)}
                  outcomeKey={headerOutcomeKey}
                  data-testid={`chat-message-${messageIndex}-tool-${partIndex}-toggle`}
                />
              ) : (
                <ToolHeader
                  type={tool.type}
                  state={tool.state}
                  title={actionLabel(
                    t,
                    tool.type.replace(/^tool-/, ""),
                    notRun,
                    workflowNameFor,
                    runKind,
                  )}
                  outcomeKey={headerOutcomeKey}
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
  const path = absolute(id ? conversationHref(id) : chatNewHref());
  window.history[replace ? "replaceState" : "pushState"]({}, "", path);
}

export function ChatPage() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const initialPrompt = chatSeedFromUrl(window.location.search).prompt;
  const [selection, setSelection] = useState<ConversationSelection>(() =>
    selectionFromPath(initialPrompt),
  );
  const [showHidden, setShowHidden] = useState(false);
  const [newPermissionMode, setNewPermissionMode] = useState<AuthoringMode>(DEFAULT_AUTHORING_MODE);
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
  // The transcript and the composer are mounted under this key. It moves only
  // when the reader moves — a new conversation, a pick from the list, back or
  // forward — never when the first send turns `/chat/new` into `/chat/<id>`.
  const [sessionKey, setSessionKey] = useState(0);
  // Whether the conversation on screen was begun here, in this session: its
  // title stays "Neue Unterhaltung" until the engine names it.
  const [startedHere, setStartedHere] = useState(() => selection.kind === "new");
  const [optimistic, setOptimistic] = useState<OptimisticMessage | null>(null);
  // The mode a new conversation was sent in, shown until its detail arrives.
  const [sentMode, setSentMode] = useState<AuthoringMode | null>(null);
  const restoreComposer = useRef<RestoreComposer | null>(null);
  // The conversation the running create stream opened, named by its first frame.
  const startedConversationId = useRef<string | null>(null);
  const navigate = (navigation: ChatNavigation, beginsHere: boolean) => {
    setSessionKey((key) => nextSessionKey(key, navigation));
    setStartedHere(beginsHere);
    setOptimistic(null);
    setSentMode(null);
  };
  useEffect(() => {
    const onPopState = () => {
      const prompt = chatSeedFromUrl(window.location.search).prompt;
      const next = selectionFromPath(prompt);
      setSelection(next);
      setSessionKey((key) => nextSessionKey(key, "popstate"));
      setStartedHere(next.kind === "new");
      setOptimistic(null);
      setSentMode(null);
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
    retry: retryConversationRead,
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
      conversationId,
    }: {
      message: string;
      references?: ConversationReference[];
      /** The target fixed when the request was sent; null creates a conversation. */
      conversationId: string | null;
    }) => {
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);

      const { workflowId, connectorId } = chatSeedFromUrl(window.location.search);
      startedConversationId.current = null;
      return sendConversationTurn(
        conversationId
          ? {
              conversationId,
              message,
              references,
              pendingElicitation: detail.data?.resume_summary?.pending_approval,
            }
          : {
              message,
              references,
              permissionMode: newPermissionMode,
              target: {
                ...(workflowId ? { workflow_id: workflowId } : {}),
                ...(connectorId ? { connector_id: connectorId } : {}),
              },
            },
        (event) => {
          if (event.type === "conversation_started") {
            const id = (event.conversation as { id?: unknown } | undefined)?.id;
            if (typeof id === "string") startedConversationId.current = id;
            return;
          }
          onTurnEvent(event);
        },
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
      // The same conversation continuing under its new address: nothing remounts.
      setSessionKey((key) => nextSessionKey(key, "firstSendSaved"));
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["decisions"] }),
        queryClient.invalidateQueries({ queryKey: ["attention"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation", result.conversation.id] }),
      ]);
    },
  });
  // What killed the last turn, as the engine recorded it. `ApiError.message`
  // already carries the engine's own sentence, and the stored one survives a
  // reload — a dead turn that still looks like a thinking one costs the reader
  // the diagnosis, which is the whole content of a provider quota message.
  const turnFailure =
    (
      detail.data as
        | {
            last_turn_error?: {
              code: string;
              message: string;
              kind?: string;
              retry_at?: string;
            } | null;
          }
        | undefined
    )?.last_turn_error ?? null;
  const turnFailureMessage =
    (send.error instanceof ApiError ? send.error.message : null) ?? turnFailure?.message ?? null;
  // The cause in the reader's language, when the engine typed it: "the
  // provider's usage limit is reached until …" is what to act on; the
  // provider's own sentence stays below it, verbatim.
  const failureCause = send.error
    ? send.error instanceof ApiError
      ? turnFailureCause({
          code: send.error.code,
          kind: send.error.details?.kind,
          retry_at: send.error.details?.retry_at,
        })
      : null
    : turnFailureCause(turnFailure);
  const failureCauseText = failureCause
    ? failureCause.kind === "provider_quota_exhausted" && failureCause.retryAt
      ? t("chat.cause.provider_quota_exhaustedUntil", {
          time: formatDateTime(locale, failureCause.retryAt),
        })
      : t(`chat.cause.${failureCause.kind}`)
    : null;
  /**
   * After a failed turn: look again, then decide — never resend by itself.
   *
   * The engine takes no idempotency key for a turn, so an automatic resend
   * can store the message twice, open a second conversation after a create
   * that timed out, or — after a reload — ask the assistant to "try again" and
   * start a live run a standing permission covers without a question. This
   * refreshes the conversation so the reader sees what actually arrived, and
   * puts the cursor in the composer: a send in this session left its text
   * there; the reader sends it again, knowingly, if it is missing.
   */
  /**
   * Every request goes through here: the composer, a starter chip, a card's
   * follow-up. The request stands in the transcript at once, in the place and
   * style the saved one will take, and stays until the saved one is there. A
   * send that failed without the engine keeping the request hands its text
   * back to the composer.
   */
  const submitTurn = async (
    message: string,
    references: ConversationReference[] = [],
  ): Promise<boolean> => {
    // The target is fixed now. An automatic page follows the list, and a list
    // that arrives while this request is in flight must not retarget it.
    const pinned = pinSelectionForSend(selection, conversations.data?.items[0]?.id);
    if (selection.kind === "automatic") setSelection(pinned);
    const targetId = pinned.kind === "existing" ? pinned.id : null;
    const pending: OptimisticMessage = {
      session: sessionKey,
      text: message,
      references,
      baseline: targetId ? userMessageCount(messages) : 0,
      sentAt: new Date().toISOString(),
    };
    setOptimistic(pending);
    if (!targetId) setSentMode(newPermissionMode);
    // What existed before a creation, read in full — not whatever the list on
    // screen holds, which is empty until it loads and filtered while a search
    // is typed. Null when it cannot be read in time: the recovery then names
    // only the conversation the create stream itself announced, and a slow
    // list never holds the request back for longer than the bound.
    const knownIds = targetId
      ? null
      : await Promise.race([
          queryClient
            .ensureQueryData({
              queryKey: ["conversations", "", "visible"],
              queryFn: () => listConversations(""),
            })
            .then((list) => new Set(list.items.map((c) => c.id)))
            .catch(() => null),
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3_000)),
        ]);
    try {
      await send.mutateAsync({ message, references, conversationId: targetId });
      return true;
    } catch {
      // A failed first send may still have opened the conversation and stored
      // the request. Find it, move there, and hand the text back only if the
      // request is not in it — otherwise a second send would store it twice.
      // Whatever goes wrong while looking, the text goes back: a request that
      // is neither in the composer nor in a transcript is lost.
      try {
        let openedId: string | null = null;
        if (!targetId) {
          const [listed] = await Promise.all([
            listConversations("").catch(() => null),
            queryClient.invalidateQueries({ queryKey: ["conversations"] }),
          ]);
          openedId = conversationOpenedByFailedSend({
            startedId: startedConversationId.current,
            knownIds,
            sentAt: pending.sentAt,
            listed: listed?.items ?? [],
          });
        }
        const after = targetId
          ? ((await detail.refetch()).data?.messages ?? null)
          : openedId
            ? ((
                await queryClient
                  .fetchQuery({
                    queryKey: ["conversation", openedId],
                    queryFn: () => getConversation(openedId ?? ""),
                  })
                  .catch(() => null)
              )?.messages ?? null)
            : null;
        const recovery = recoverFailedSend({
          activeId: targetId,
          openedId,
          optimistic: pending,
          messagesAfter: after,
        });
        if (recovery.switchTo) {
          setSelection({ kind: "existing", id: recovery.switchTo });
          setChatPath(recovery.switchTo, true);
          setSessionKey((key) => nextSessionKey(key, "firstSendSaved"));
        }
        if (!recovery.restoreComposer) return true;
      } catch {
        // Fall through: hand the text back.
      }
      setOptimistic(null);
      restoreComposer.current?.(message, references);
      return false;
    }
  };
  const retryTurn = async () => {
    send.reset();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversation", activeId] }),
      queryClient.invalidateQueries({ queryKey: ["conversations"] }),
    ]);
    document.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]')?.focus();
  };
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
      choiceValue,
      textValue,
      formOutput,
    }: {
      toolCallId?: string;
      elicitationId?: string;
      approved?: boolean;
      choiceValue?: string;
      textValue?: string;
      formOutput?: Record<string, unknown>;
    }) => {
      setStreamedText("");
      setStreamedDiffs([]);
      setLiveCalls([]);
      return elicitationId
        ? formOutput !== undefined
          ? respondToChatForm(activeId ?? "", elicitationId, formOutput, onTurnEvent)
          : choiceValue !== undefined
            ? respondToChatChoice(activeId ?? "", elicitationId, choiceValue, onTurnEvent)
            : textValue !== undefined
              ? respondToChatText(activeId ?? "", elicitationId, textValue, onTurnEvent)
              : respondToChatApproval(activeId ?? "", elicitationId, approved === true, onTurnEvent)
        : respondToToolCall(activeId ?? "", toolCallId ?? "", approved === true);
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
          queryClient.invalidateQueries({ queryKey: ["decisions"] }),
          queryClient.invalidateQueries({ queryKey: ["attention"] }),
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
  const submitChoice = (elicitationId: string, choiceValue: string) => {
    if (decisionLock.current || send.isPending || decide.isPending) return;
    decisionLock.current = true;
    send.reset();
    decide.mutate({ elicitationId, choiceValue });
  };
  const submitText = (elicitationId: string, textValue: string) => {
    if (decisionLock.current || send.isPending || decide.isPending) return;
    decisionLock.current = true;
    send.reset();
    decide.mutate({ elicitationId, textValue });
  };
  const submitForm = (elicitationId: string, formOutput: Record<string, unknown>) => {
    if (decisionLock.current || send.isPending || decide.isPending) return;
    decisionLock.current = true;
    send.reset();
    decide.mutate({ elicitationId, formOutput });
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
  const pendingChoice = chatChoice(detail.data);
  const pendingForm = useMemo(() => chatForm(detail.data), [detail.data]);
  const pendingText = useMemo(() => chatText(detail.data), [detail.data]);
  // A question with no tool row to stand beside — parked from prose, or a
  // call the transcript did not anchor — is shown below the transcript.
  const pendingTextInline = pendingText ? questionIsInTranscript(pendingText, messages) : false;
  // The user messages that answer a text question: the engine projects each
  // answer as a message carrying the question's id.
  const answerMessageIds = useMemo(
    () =>
      new Set(
        (detail.data?.tool_calls ?? []).flatMap((call) => {
          const output = call.output as { status?: unknown; elicitation_id?: unknown } | null;
          return call.tool === "ask_user_text" &&
            output?.status === "resolved" &&
            typeof output.elicitation_id === "string"
            ? [output.elicitation_id]
            : [];
        }),
      ),
    [detail.data],
  );
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
  const workflowCatalogue = useQuery({
    queryKey: ["chat", "workflow-names"],
    enabled: session.permissions.includes("workflow:read"),
    queryFn: () =>
      apiRequest<{ items: { slug?: string | null; name?: string | null }[] }>(
        "/v1/workflows?limit=200",
      ),
  });
  const workflowNameFor = useMemo(() => {
    const items = workflowCatalogue.data?.items ?? [];
    return (slug: string) => resolveWorkflowNameBySlug(items, slug);
  }, [workflowCatalogue.data]);
  const heldSchedules = useHeldSchedules(session.permissions);
  const targetWorkflowId =
    resume?.active_target.kind === "workflow" ? resume.active_target.id : null;
  const heldTarget = heldSchedules.find((schedule) => schedule.workflow_id === targetWorkflowId);
  const automationStatus = useQuery({
    queryKey: ["workflow-automation-status", targetWorkflowId],
    enabled: Boolean(targetWorkflowId && session.permissions.includes("schedule:read")),
    queryFn: () =>
      apiRequest<{
        schedules: { ready: boolean; next_run_at: string | null; timezone: string }[];
        inbound_hooks?: { ready: boolean }[];
      }>(`/v1/workflows/${encodeURIComponent(targetWorkflowId!)}/automation-status`),
    refetchInterval: 15000,
  });
  const readySchedules =
    automationStatus.data?.schedules?.filter((schedule) => schedule.ready) ?? [];
  // A webhook has no next run to name, but a ready one is automatic operation
  // all the same: a webhook-only workflow was never announced as ready.
  const readyAutomations =
    readySchedules.length +
    (automationStatus.data?.inbound_hooks?.filter((hook) => hook.ready).length ?? 0);
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
      ? { label: t("chat.outcome.in_progress"), waiting: false }
      : resume?.pending_approval || activeRow?.outcome === "awaiting_you"
        ? { label: t("chat.outcome.awaiting_you"), waiting: true }
        : resume?.stage === "workflow_saved"
          ? { label: t("chat.resume.stage.workflowSaved"), waiting: false }
          : activeRow?.outcome === "in_progress" || (!activeRow && current?.status === "active")
            ? { label: t("chat.outcome.in_progress"), waiting: false }
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
  const startNew = () => {
    setSelection({ kind: "new" });
    navigate("startNew", true);
    setNewPermissionMode(DEFAULT_AUTHORING_MODE);
    setChatPath(null);
    setListOpen(false);
  };
  // A conversation that cannot be opened — unknown, not yours, or the read
  // failed — used to fall through to the empty new-chat screen: starter cards
  // and a composer, as if nothing had been asked for, and a message typed
  // there would have gone to the conversation that had just failed.
  const conversationFailed = Boolean(activeId) && queryView(detail, () => false) === "error";
  // Unknown or not the reader's: retrying cannot help, the way on is the list.
  // Read from `failureReason` too — `error` stays empty while a read retries.
  const conversationMissing =
    conversationFailed &&
    conversationFailureKind(detail.error ?? detail.failureReason) === "missing";
  const listFailed = queryView(conversations, () => false) === "error";
  const storedMode = detail.data ? storedAuthoringMode(detail.data.draft) : "loading";
  // A text question is answered by the next message — said in so many words,
  // naming the question, so a message is never an answer by surprise.
  const composerHint =
    pendingChoice || pendingForm
      ? { text: t("chat.choice.hint"), visible: true }
      : pendingText && !send.isPending
        ? {
            text: t("chat.text.composerHint", { question: questionExcerpt(pendingText.question) }),
            visible: true,
          }
        : null;
  // The mode in force: the one being picked, the one the conversation was
  // started in — or, while a conversation begun here loads its detail, the
  // one it was just sent in, so the pill does not pass through "loading". A
  // legacy or armed exception has no matrix this page can state, so it shows
  // its name and no matrix rather than a guess.
  const storedConcrete: AuthoringMode | null =
    storedMode === "auto" || storedMode === "ask" || storedMode === "plan" ? storedMode : null;
  const pillMode: AuthoringMode | null = !activeId
    ? newPermissionMode
    : (storedConcrete ?? (storedMode === "loading" ? sentMode : null));
  const pillLabel = pillMode
    ? t(modeLabelKey(pillMode))
    : storedMode === "loading"
      ? null
      : t(`chat.mode.${storedMode}`);
  const headerTitle = chatHeaderTitle({
    title: current?.title,
    listTitle: activeRow?.title,
    failed: conversationFailed,
    activeId,
    startedHere,
    loaded: Boolean(detail.data),
  });
  const summaryLine = conversationFailed ? null : resumeSummaryLine(resume, t);
  const showOptimistic = optimisticVisible(optimistic, sessionKey, messages);
  const canReadStats = session.permissions.includes("stats:read");
  const monthStatus = useQuery({
    queryKey: ["usage-status"],
    enabled: canReadStats,
    queryFn: () => apiRequest<unknown>("/v1/status"),
  });
  const budget = budgetPill(budgetPressure(budgetSummary(monthStatus.data)));
  const headerSlot = useChatHeaderSlot();
  // The chat's header lives in the shell's top bar, beside the sidebar toggle:
  // title and state on the left, the mode and what this conversation consumed
  // in the middle, the three ways out on the right. On a phone the pills take
  // a second row instead of scrolling sideways.
  const chatHeader = (
    <div
      className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid="chat-header"
    >
      <div className="min-w-0 flex-1">
        <h1
          className="truncate text-sm font-semibold"
          data-testid="chat-title"
          data-title-kind={headerTitle.kind}
          aria-busy={headerTitle.kind === "loading" || undefined}
        >
          {headerTitle.kind === "title"
            ? headerTitle.text
            : headerTitle.kind === "loading"
              ? " "
              : t(
                  headerTitle.kind === "unavailable"
                    ? "chat.unavailable"
                    : headerTitle.kind === "untitled"
                      ? "chat.untitled"
                      : "chat.new",
                )}
        </h1>
        {/* §5: the state line of a conversation that has one. A new
            conversation has no state yet, and says nothing rather than a
            sentence about the product. */}
        {summaryLine ? (
          <p className="truncate text-xs text-muted-foreground" data-testid="chat-summary">
            {summaryLine}
          </p>
        ) : null}
      </div>
      <div
        className="order-last flex w-full flex-wrap items-center gap-1.5 sm:order-none sm:w-auto"
        data-testid="chat-pills"
      >
        {conversationFailed || !pillLabel ? null : (
          <ModePill
            mode={pillMode}
            label={pillLabel}
            editable={!activeId}
            disabled={send.isPending}
            onChange={setNewPermissionMode}
          />
        )}
        <UsagePills usage={activeId ? detail.data?.usage : null} budget={budget} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* A badge earns its place by changing what the reader does next.
            "Waiting for you" and "In progress" do; "Answered" and "Idle"
            are the resting state and were on almost every conversation. */}
        {current && badge && (
          // "Wartet auf dich" is amber (§2) — the same tone the list
          // gives it. It was red here and amber there: one state, two
          // alarms of different weight.
          <Badge
            variant="outline"
            className={cn(badge.waiting && "border-warning/40 bg-warning/10 text-warning")}
            data-testid="chat-status"
            data-waiting={badge.waiting || undefined}
          >
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
        <IconButton label={t("chat.new")} data-testid="conversation-new" onClick={startNew}>
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
  );
  const list = (
    <ConversationList
      failed={
        listFailed
          ? { title: t("chat.list.loadFailed"), onRetry: () => void conversations.refetch() }
          : null
      }
      conversations={listRows}
      activeId={activeId}
      showHidden={showHidden}
      onToggleHidden={() => setShowHidden((value) => !value)}
      onHide={(conversation, hidden) => hide.mutate({ id: conversation.id, hidden })}
      onSelect={(id) => {
        setSelection({ kind: "existing", id });
        navigate("select", false);
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
        {headerSlot ? createPortal(chatHeader, headerSlot) : null}

        {/* The turn that just died, and the one that died before a reload. The
            engine's own sentence is shown verbatim: "you have reached your
            specified API usage limits" tells the reader what to do, and a
            constant string does not. */}
        {(send.error || turnFailure) && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-error">
            {send.error instanceof ApiError && send.error.code === "pending_elicitation_blocked" ? (
              <>
                <AlertTitle>{t("chat.failed")}</AlertTitle>
                <AlertDescription>
                  {t(
                    (send.error.details?.pending_elicitation as { tool_name?: unknown } | undefined)
                      ?.tool_name === "ask_user_text"
                      ? "chat.text.blocked"
                      : "chat.pendingQuestionRequired",
                  )}
                </AlertDescription>
              </>
            ) : (
              <>
                {/* A known cause is the headline; the provider's own words stay
                    one click away instead of a block of red monospace. */}
                <AlertTitle data-testid={failureCauseText ? "chat-error-cause" : undefined}>
                  {failureCauseText ?? t("chat.failed")}
                </AlertTitle>
                <AlertDescription>
                  <p>{t(failureCauseText ? "chat.failedKept" : "chat.failedDescription")}</p>
                  {!failureCauseText && <p className="mt-1">{t("chat.retryManual")}</p>}
                  {turnFailureMessage && (
                    <details className="mt-1 text-xs" data-testid="chat-error-detail">
                      <summary className="cursor-pointer">{t("chat.failedDetail")}</summary>
                      <p className="mt-1 break-words font-mono">{turnFailureMessage}</p>
                    </details>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={send.isPending || decide.isPending}
                      onClick={() => void retryTurn()}
                      data-testid="chat-error-retry"
                    >
                      {t("chat.retryCheck")}
                    </Button>
                  </div>
                </AlertDescription>
              </>
            )}
          </Alert>
        )}

        {decide.isError && !pendingDecision && !pendingChoice && !pendingForm && (
          <Alert variant="destructive" className="m-4 mb-0" data-testid="chat-decision-error">
            <AlertDescription>{t("chat.decision.failed")}</AlertDescription>
          </Alert>
        )}
        <MessageScrollerProvider key={sessionKey} autoScroll>
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
                {conversationFailed ? (
                  <LoadFailed
                    title={t(conversationMissing ? "chat.notFound" : "chat.loadFailed")}
                    description={conversationMissing ? t("chat.notFoundDescription") : undefined}
                    onRetry={conversationMissing ? undefined : () => void detail.refetch()}
                    testId="chat-load-failed"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setListOpen(true)}
                      data-testid="chat-load-failed-list"
                    >
                      {t("chat.conversations.open")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={startNew}
                      data-testid="chat-load-failed-new"
                    >
                      {t("chat.new")}
                    </Button>
                  </LoadFailed>
                ) : messages.length === 0 && !send.isPending && !showOptimistic ? (
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
                        onPick={(prompt) => void submitTurn(prompt)}
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
                        onText={submitText}
                        answersQuestion={answerMessageIds.has(message.id)}
                        approvalBusy={send.isPending || decide.isPending}
                        approvalError={
                          decide.isError &&
                          decide.variables?.elicitationId ===
                            (pendingDecision?.id ??
                              pendingChoice?.id ??
                              pendingForm?.id ??
                              pendingText?.id)
                        }
                        onApproval={submitApproval}
                        nameFor={nameFor}
                        workflowNameFor={workflowNameFor}
                        onAutomationAdjust={(workflowId) =>
                          void submitTurn(t("authority.adjustPrompt"), [
                            {
                              type: "workflow",
                              id: workflowId,
                              label: t("chat.singleRun.thisWorkflow"),
                            },
                          ])
                        }
                        onReauth={(action) => {
                          if (pendingDecision || pendingChoice || pendingForm || pendingText) {
                            setContextOpen(true);
                            return;
                          }
                          void submitTurn(t("chat.reauth.prompt"), [
                            {
                              type: "connector",
                              id: action.connectorId,
                              label: action.label || t("chat.reauth.title"),
                            },
                          ]);
                        }}
                        onDecision={(toolCallId, approved) =>
                          decide.mutate({ toolCallId, approved })
                        }
                      />
                    </MessageScrollerItem>
                  ))
                )}
                {/* The request just sent, where and as the saved one will stand:
                    left, under "Du", in the question tone. It used to be a dark
                    bubble on the right that vanished when the turn ended and
                    came back on the left after a gap. It stays until the saved
                    request is in the transcript, so there is no gap. */}
                {showOptimistic && optimistic ? (
                  <MessageScrollerItem key="optimistic" data-testid="chat-pending-message">
                    <ChatMessage
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
                      nameFor={nameFor}
                      workflowNameFor={workflowNameFor}
                    />
                  </MessageScrollerItem>
                ) : null}
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
                              <details className="min-w-0 w-full">
                                <summary>{t("chat.activity.details")}</summary>
                                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">
                                  {call.logTail}
                                </pre>
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
                <MessageScrollerItem data-testid="chat-next-action">
                  {pendingText && !pendingTextInline && (
                    <ChatTextCard
                      text={pendingText}
                      busy={send.isPending || decide.isPending}
                      error={decide.isError && decide.variables?.elicitationId === pendingText.id}
                      onAnswer={submitText}
                      testId="chat-text-question"
                    />
                  )}
                  {resume?.unsaved &&
                    targetWorkflowId &&
                    !pendingDecision &&
                    !pendingChoice &&
                    !pendingForm &&
                    !pendingText &&
                    status === "ready" && (
                      <Alert className="bg-accent/10" data-testid="chat-preparation-next-step">
                        <AlertTitle>{t("chat.preparation.title")}</AlertTitle>
                        <AlertDescription>
                          <p>{t("chat.preparation.effect")}</p>
                          <Button
                            size="sm"
                            onClick={() => void submitTurn(t("chat.preparation.prompt"))}
                            data-testid="chat-continue-preparation"
                          >
                            {t("chat.preparation.continue")}
                          </Button>
                        </AlertDescription>
                      </Alert>
                    )}

                  {heldTarget &&
                    !resume?.unsaved &&
                    targetWorkflowId &&
                    !pendingDecision &&
                    !pendingChoice &&
                    !pendingForm &&
                    !pendingText &&
                    status === "ready" && (
                      <Alert className="bg-accent/10" data-testid="chat-schedule-next-step">
                        <AlertTitle>{t("chat.schedule.pending")}</AlertTitle>
                        <AlertDescription>
                          <p>{t("chat.schedule.effect")}</p>
                          <AutomationGrant
                            workflowId={targetWorkflowId}
                            environment={heldTarget.execution_mode}
                            testId="chat-review-schedule"
                            onPrepareSingleRun={() =>
                              void submitTurn(t("chat.activation.singlePrompt"))
                            }
                            onAdjust={() => void submitTurn(t("authority.adjustPrompt"))}
                          />
                        </AlertDescription>
                      </Alert>
                    )}

                  {!heldTarget &&
                    !resume?.unsaved &&
                    readyAutomations > 0 &&
                    status === "ready" && (
                      <Alert
                        className="bg-accent/10 border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
                        data-testid="chat-automation-ready"
                      >
                        <AlertTitle>{t("chat.automation.ready")}</AlertTitle>
                        <AlertDescription>
                          <p>{t("chat.automation.readyHint")}</p>
                          {readySchedules.map(
                            (schedule, index) =>
                              schedule.next_run_at && (
                                <p key={`${schedule.next_run_at}-${index}`}>
                                  {t("authority.report.next", {
                                    time: new Intl.DateTimeFormat(locale, {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                      timeZone: schedule.timezone,
                                    }).format(new Date(schedule.next_run_at)),
                                    zone: schedule.timezone,
                                  })}
                                </p>
                              ),
                          )}
                        </AlertDescription>
                      </Alert>
                    )}
                </MessageScrollerItem>
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
          // No composer aimed at a conversation that could not be opened.
          hidden={conversationFailed}
        >
          <div className={COLUMN}>
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
            {/* Where the answer goes, shown above the field. A text question
                names itself here: a placeholder alone ("your answer to the
                question") was the only sign of a question nobody could see,
                and the next message was taken as its answer. A choice or form
                disables the field and points at its card. */}
            {composerHint ? (
              <p
                id="chat-composer-hint"
                className={composerHint.visible ? "mb-2 text-sm text-muted-foreground" : "sr-only"}
                data-testid="chat-composer-hint"
              >
                {composerHint.text}
              </p>
            ) : null}
            <PromptInputProvider
              key={sessionKey}
              initialInput={selection.kind === "new" ? initialPrompt : ""}
            >
              <ChatComposer
                disabled={
                  send.isPending || decide.isPending || Boolean(pendingChoice || pendingForm)
                }
                status={status}
                // While a text question waits, the field takes its answer.
                placeholder={
                  pendingText ? t("chat.text.placeholder") : t("chat.composer.placeholder")
                }
                describedBy={composerHint ? "chat-composer-hint" : undefined}
                onStop={() => cancel.mutate()}
                onSend={submitTurn}
                restoreRef={restoreComposer}
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
            {pendingChoice && (
              <div className="p-4">
                <ChatChoiceCard
                  choice={pendingChoice}
                  busy={send.isPending || decide.isPending}
                  error={decide.isError}
                  onAnswer={submitChoice}
                  testId="chat-context-choice"
                />
              </div>
            )}
            {pendingForm && (
              <ChatFormCard
                form={pendingForm}
                busy={decide.isPending}
                error={decide.isError}
                onAnswer={submitForm}
                testId="chat-context-form"
              />
            )}
            {pendingText && (
              <div className="p-4">
                <ChatTextCard
                  text={pendingText}
                  busy={send.isPending || decide.isPending}
                  error={decide.isError && decide.variables?.elicitationId === pendingText.id}
                  onAnswer={submitText}
                  testId="chat-context-text-question"
                />
              </div>
            )}
            {pendingDecision && (
              <div className="p-4 pb-0">
                <ChatApprovalCard
                  approval={pendingDecision}
                  busy={send.isPending || decide.isPending}
                  error={
                    decide.isError &&
                    decide.variables?.elicitationId ===
                      (pendingDecision?.id ?? pendingChoice?.id ?? pendingForm?.id)
                  }
                  onDecision={submitApproval}
                  testId="chat-context-approval"
                />
              </div>
            )}
            <dl className="grid gap-4 p-4 text-sm">
              {/* Where it came from, whose it is, when it last moved. It stood
                  in the header as a third line; the header now carries the
                  title and what the reader acts on, and this is context. */}
              {current && origin ? (
                <div data-testid="chat-origin">
                  <dt className="text-xs text-muted-foreground">{t("chat.context.origin")}</dt>
                  <dd className="mt-1">{origin}</dd>
                </div>
              ) : null}
              <div data-testid="chat-context-stage">
                <dt className="text-xs text-muted-foreground">{t("chat.context.stage")}</dt>
                <dd className="mt-1 font-medium">
                  {decide.isPending
                    ? t("chat.decision.processing")
                    : pendingChoice || pendingForm || pendingText
                      ? t("chat.choice.title")
                      : resumeStageLabel(resume?.stage, t)}
                </dd>
              </div>
              <div data-testid="chat-context-target">
                <dt className="text-xs text-muted-foreground">{t("chat.context.target")}</dt>
                <dd className="mt-1 font-medium">
                  {localizedTarget(resume?.active_target.name || resume?.active_target.kind, t)}
                </dd>
              </div>
              {!pendingDecision && !pendingChoice && !pendingForm && !pendingText && (
                <div data-testid="chat-context-next-action">
                  <dt className="text-xs text-muted-foreground">{t("chat.context.nextAction")}</dt>
                  <dd className="mt-1">{resumeNextAction(resume?.stage, t)}</dd>
                </div>
              )}
              {heldTarget && targetWorkflowId && (
                <div data-testid="chat-context-held-schedule">
                  <dt className="text-xs text-muted-foreground">{t("chat.schedule.pending")}</dt>
                  <dd className="mt-1 flex flex-col gap-2">
                    <p>{t("chat.schedule.effect")}</p>
                    <AutomationGrant
                      workflowId={targetWorkflowId}
                      environment={heldTarget.execution_mode}
                      testId="chat-context-review-schedule"
                      onPrepareSingleRun={() => {
                        setContextOpen(false);
                        void submitTurn(t("chat.activation.singlePrompt"));
                      }}
                      onAdjust={() => {
                        setContextOpen(false);
                        void submitTurn(t("authority.adjustPrompt"));
                      }}
                    />
                  </dd>
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
              {resume?.pending_approval && !pendingDecision && !pendingChoice && !pendingForm && (
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
