import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, PanelRight, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  ApiError,
  apiRequest,
  type Conversation,
  type ConversationReference,
  cancelConversation,
  deleteConversation,
  getConversation,
  OWN_CONVERSATIONS,
  renameConversation,
  respondToChatApproval,
  respondToChatChoice,
  respondToChatForm,
  respondToToolCall,
  sendConversationTurn,
} from "@/api/client";
import {
  absolute,
  chatSeedFromUrl,
  chatTargetFromUrl,
  conversationHref,
  runHref,
} from "@/app/links";
import { useLiveQueryOptions } from "@/app/live-events";
import { useSession } from "@/app/session";
import { CHAT_COLUMN } from "@/app/shell-header";
import { useHeldSchedules } from "@/app/use-decisions";
import { MessageResponse } from "@/components/ai-elements/message";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { DiffCard } from "@/components/cockpit/diff-card";
import { IconButton } from "@/components/cockpit/icon-button";
import {
  ActionMenu,
  Bubble,
  BubbleContent,
  Button,
  ChatCard,
  CodeBlock,
  ConfirmDialog,
  DataState,
  type Fact,
  FactList,
  Field,
  FieldLabel,
  FormDialog,
  Input,
  Message,
  MessageContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Page,
  PageHeader,
  RecordSheet,
  SectionHeading,
  Spinner,
  StatusBadge,
  StatusStrip,
} from "@/components/cockpit/patterns";
import { queryView } from "@/components/failure-state";
import {
  type AttachmentPreview,
  AttachmentPreviewSheet,
  actionLabel,
  asStreamedDiff,
  ChatComposer,
  ChatMessage,
  catalogHref,
  FollowSubmittedTurn,
  localizedTarget,
  ModePill,
  NO_LIVE_REVIEWS,
  originLine,
  ReadingColumn,
  type RestoreComposer,
  type StreamedDiff,
  selectionFromPath,
  setChatPath,
  UsagePills,
} from "@/features/chat";
import { formatDateTime, formatRelativeTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { ResolvedIdentifier } from "@/lib/identifiers";
import { resolveWorkflowNameBySlug } from "@/lib/name-index";
import { conversationExcerpt, hideTechnicalIdentifiers, humanFacingText } from "@/lib/presentation";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { cn } from "@/lib/utils";
import {
  approvalLine,
  chatApproval,
  conversationRefreshInterval,
  pendingApprovalSubject,
  waitsForPerson,
} from "./chat-approval";
import { ChatApprovalCard } from "./chat-approval-card";
import {
  addAttachments,
  attachmentName,
  attachmentSize,
  createEmptyConversation,
  linkAttachment,
  listConversationAttachments,
  messageWithAttachments,
  type PendingAttachment,
  takeAttachmentFiles,
} from "./chat-attachments";
import { liveAutomationReviews } from "./chat-automation-tool";
import { chatChoice } from "./chat-choice";
import { ChatChoiceCard } from "./chat-choice-card";
import { ConversationList } from "./chat-conversation-list";
import { chatForm } from "./chat-form";
import { ChatFormCard } from "./chat-form-card";
import { HeldScheduleAction, heldScheduleCopy } from "./chat-held-schedule";
import { applyLiveCall, elapsedMs, type LiveCall, reduceLiveCall } from "./chat-live-calls";
import { conversationFailureKind, retryConversationRead } from "./chat-load-failure";
import { DEFAULT_AUTHORING_MODE, modeLabelKey } from "./chat-mode";
import { type AuthoringMode, storedAuthoringMode } from "./chat-permission";
import {
  type PlaybookAction,
  playbookActionTarget,
  playbookAnchorIndex,
  playbookSummaryVisible,
} from "./chat-playbook";
import { ChatPlaybookPanel, ChatPlaybookSummary } from "./chat-playbook-panel";
import { latestDryRunCallId, savedSensitivePreviews } from "./chat-preview-cards";
import { collectReferencedResources, namedResources } from "./chat-references";
import {
  liveTestState,
  resumeNextAction,
  resumeStageLabel,
  resumeSummaryLine,
} from "./chat-resume";
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
  nextSessionKey,
  type OptimisticMessage,
  optimisticUiMessage,
  optimisticVisible,
  ownsChatOperation,
  recoverFailedSend,
  turnFailureCause,
  userMessageCount,
} from "./chat-session";
import { ChatStart } from "./chat-start";
import { chatText, questionExcerpt } from "./chat-text";
import { groupMessageParts } from "./chat-transcript";
import { chatContextControlsTarget, useChatWorkspace } from "./chat-workspace";
import { budgetPressure, budgetSummary } from "./usage-model";

export function ChatPage() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const initialPrompt = chatSeedFromUrl(window.location.search).prompt;
  const [selection, setSelection] = useState<ConversationSelection>(() =>
    selectionFromPath(initialPrompt),
  );
  const [showHidden, setShowHidden] = useState(false);
  const [newPermissionMode, setNewPermissionMode] = useState<AuthoringMode>(DEFAULT_AUTHORING_MODE);
  const [streamedText, setStreamedText] = useState("");
  const [streamedDiffs, setStreamedDiffs] = useState<StreamedDiff[]>([]);
  const [liveCalls, setLiveCalls] = useState<LiveCall[]>([]);
  const [liveTick, setLiveTick] = useState(0);
  const anyLive = liveCalls.some((call) => !call.done);
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setLiveTick((tick) => tick + 1), 250);
    return () => clearInterval(timer);
  }, [anyLive]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [startedHere, setStartedHere] = useState(() => selection.kind === "new");
  const [optimistic, setOptimistic] = useState<OptimisticMessage | null>(null);
  const [sentMode, setSentMode] = useState<AuthoringMode | null>(null);
  const restoreComposer = useRef<RestoreComposer | null>(null);
  const sessionRef = useRef(0);
  const operationRef = useRef<object | null>(null);
  const ownsOperation = (operation: ReturnType<typeof beginOperation>) =>
    ownsChatOperation(operationRef.current, operation, sessionRef.current);
  const beginOperation = () => {
    const operation = { session: sessionRef.current, startedId: null as string | null };
    operationRef.current = operation;
    return operation;
  };
  const navigate = (navigation: ChatNavigation, beginsHere: boolean) => {
    sessionRef.current = nextSessionKey(sessionRef.current, navigation);
    setSessionKey(sessionRef.current);
    clearStream();
    setStartedHere(beginsHere);
    setOptimistic(null);
    setSentMode(null);
  };
  useEffect(() => {
    const onPopState = () => {
      const prompt = chatSeedFromUrl(window.location.search).prompt;
      const next = selectionFromPath(prompt);
      setSelection(next);
      sessionRef.current = nextSessionKey(sessionRef.current, "popstate");
      setSessionKey(sessionRef.current);
      clearStream();
      setStartedHere(next.kind === "new");
      setOptimistic(null);
      setSentMode(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const conversationList = useInfiniteList<Conversation>(
    "/v1/conversations",
    { ...OWN_CONVERSATIONS, ...(showHidden ? { hidden: "only" } : {}) },
    { queryKey: ["conversations", "infinite", showHidden ? "hidden" : "visible"] },
  );
  const hiddenConversations = useQuery({
    queryKey: ["conversations", "hidden-presence"],
    queryFn: () => {
      const params = new URLSearchParams({ ...OWN_CONVERSATIONS, hidden: "only", limit: "1" });
      return apiRequest<{ items: Conversation[] }>(`/v1/conversations?${params}`);
    },
    retry: retryConversationRead,
  });
  const conversations = conversationList.query;
  const activeId = activeConversationId(selection, conversationList.items[0]?.id);
  useEffect(() => {
    if (selection.kind === "automatic" && activeId) setChatPath(activeId, true);
  }, [activeId, selection.kind]);
  const detail = useQuery({
    queryKey: ["conversation", activeId],
    queryFn: () => getConversation(activeId ?? ""),
    enabled: Boolean(activeId),
    retry: retryConversationRead,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => conversationRefreshInterval(query.state.data),
  });
  const clearStream = () => {
    setStreamedText("");
    setStreamedDiffs([]);
    setLiveCalls([]);
  };
  const loadTranscript = (id: string | null): Promise<boolean> =>
    id
      ? queryClient
          .cancelQueries({ queryKey: ["conversation", id], exact: true })
          .then(() =>
            queryClient.fetchQuery({
              queryKey: ["conversation", id],
              queryFn: () => getConversation(id),
              staleTime: 0,
            }),
          )
          .then(
            () => true,
            () => false,
          )
      : Promise.resolve(false);
  const onTurnEvent = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "tool_result" && event.tool === "update_playbook" && activeId) {
      void queryClient.invalidateQueries({ queryKey: ["conversation", activeId], exact: true });
    }
    if (event.type === "text_delta" && typeof event.text === "string") {
      setStreamedText((currentText) => currentText + event.text);
      return;
    }
    const live = reduceLiveCall(event);
    if (live) {
      setLiveCalls((calls) => applyLiveCall(calls, live));
      return;
    }
    const diff = asStreamedDiff(event);
    if (diff) setStreamedDiffs((current) => [...current, diff]);
  };
  const send = useMutation({
    mutationFn: async ({
      message,
      references,
      conversationId,
      attachments = [],
      operation,
    }: {
      message: string;
      references?: ConversationReference[];
      conversationId: string | null;
      operation: ReturnType<typeof beginOperation>;
      attachments?: readonly PendingAttachment[];
    }) => {
      clearStream();

      const target = chatTargetFromUrl(window.location.search);
      const intakeItemIds = chatSeedFromUrl(window.location.search).intakeItemIds;
      let targetId = conversationId;
      let text = message;
      if (attachments.length > 0) {
        if (!targetId) {
          const opened = await createEmptyConversation({
            target,
            permissionMode: newPermissionMode,
            intakeItemIds,
          });
          targetId = opened.id;
          operation.startedId = opened.id;
        }
        const slugs: string[] = [];
        for (const attachment of attachments)
          slugs.push(await linkAttachment(targetId, attachment));
        text = messageWithAttachments(message, slugs);
      }
      return sendConversationTurn(
        targetId
          ? {
              conversationId: targetId,
              message: text,
              references,
              pendingElicitation:
                (await getConversation(targetId)).resume_summary?.pending_approval ?? null,
            }
          : {
              message: text,
              references,
              permissionMode: newPermissionMode,
              target,
              ...(intakeItemIds.length ? { intake_item_ids: intakeItemIds } : {}),
            },
        (event) => {
          if (event.type === "conversation_started") {
            const id = (event.conversation as { id?: unknown } | undefined)?.id;
            if (typeof id === "string") operation.startedId = id;
            return;
          }
          if (ownsOperation(operation)) onTurnEvent(event);
        },
      );
    },
    onError: async (_error, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["conversation", variables.conversationId] });
    },
    onSuccess: async (result, variables) => {
      const id = result.conversation.id;
      const loaded = await loadTranscript(id);
      if (ownsOperation(variables.operation)) {
        setSelection({ kind: "existing", id });
        setChatPath(id, true);
        clearStream();
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["decisions"] }),
        queryClient.invalidateQueries({ queryKey: ["attention"] }),
        loaded ? null : queryClient.invalidateQueries({ queryKey: ["conversation", id] }),
      ]);
    },
  });
  const sendPending = send.isPending && send.variables?.operation.session === sessionKey;
  const sendError = send.variables?.operation.session === sessionKey ? send.error : null;
  const turnFailure =
    (
      detail.data as
        | {
            last_turn_error?: {
              code: string;
              message: string;
              kind?: string;
              retry_at?: string;
              timeout?: { timeout_ms?: number | null };
            } | null;
          }
        | undefined
    )?.last_turn_error ?? null;
  const turnFailureMessage =
    (sendError instanceof ApiError ? sendError.message : null) ?? turnFailure?.message ?? null;
  const failureCause = sendError
    ? sendError instanceof ApiError
      ? turnFailureCause({
          code: sendError.code,
          kind: sendError.details?.kind,
          retry_at: sendError.details?.retry_at,
          timeout_ms: sendError.details?.timeout_ms,
        })
      : null
    : turnFailureCause(
        turnFailure ? { ...turnFailure, timeout_ms: turnFailure.timeout?.timeout_ms } : null,
      );
  const failureCauseText = failureCause
    ? failureCause.kind === "provider_timeout"
      ? failureCause.timeoutMs !== null
        ? t("chat.cause.provider_timeout", { seconds: Math.ceil(failureCause.timeoutMs / 1000) })
        : t("chat.cause.provider_timeoutUnknown")
      : failureCause.kind === "provider_quota_exhausted" && failureCause.retryAt
        ? t("chat.cause.provider_quota_exhaustedUntil", {
            time: formatDateTime(locale, failureCause.retryAt),
          })
        : t(`chat.cause.${failureCause.kind}`)
    : null;
  const submitTurn = async (
    message: string,
    references: ConversationReference[] = [],
  ): Promise<boolean> => {
    const operation = beginOperation();
    const pinned = pinSelectionForSend(selection, conversationList.items[0]?.id);
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
    const sentAttachments = attachments;
    setAttachments([]);
    try {
      await send.mutateAsync({
        message,
        references,
        conversationId: targetId,
        attachments: sentAttachments,
        operation,
      });
      return true;
    } catch {
      if (!ownsOperation(operation)) return false;
      try {
        let openedId: string | null = null;
        if (!targetId) {
          await queryClient.invalidateQueries({ queryKey: ["conversations"] });
          openedId = conversationOpenedByFailedSend({
            startedId: operation.startedId,
            knownIds: null,
            sentAt: pending.sentAt,
            listed: [],
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
        if (!ownsOperation(operation)) return false;
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
      } catch {}
      if (!ownsOperation(operation)) return false;
      setOptimistic(null);
      restoreComposer.current?.(message, references);
      setAttachments((current) => addAttachments(sentAttachments, current));
      return false;
    }
  };
  const fillComposer = (prompt: string) => {
    restoreComposer.current?.(prompt, []);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer-input"]',
      );
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
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
    mutationFn: (id: string) => cancelConversation(id),
    onSuccess: (_result, id) => queryClient.invalidateQueries({ queryKey: ["conversation", id] }),
  });
  const decisionLock = useRef<ReturnType<typeof beginOperation> | null>(null);
  const decide = useMutation({
    mutationFn: ({
      toolCallId,
      elicitationId,
      approved,
      choiceValue,
      formOutput,
      operation,
      conversationId,
    }: {
      operation: ReturnType<typeof beginOperation>;
      conversationId: string;
      toolCallId?: string;
      elicitationId?: string;
      approved?: boolean;
      choiceValue?: string;
      formOutput?: Record<string, unknown>;
    }) => {
      clearStream();
      let resolutionRefreshed = false;
      const onEvent = (event: Parameters<typeof onTurnEvent>[0]) => {
        if (!ownsOperation(operation)) return;
        if (!resolutionRefreshed) {
          resolutionRefreshed = true;
          void queryClient.invalidateQueries({
            queryKey: ["conversation", conversationId],
            exact: true,
          });
        }
        onTurnEvent(event);
      };
      return elicitationId
        ? formOutput !== undefined
          ? respondToChatForm(conversationId, elicitationId, formOutput, onEvent)
          : choiceValue !== undefined
            ? respondToChatChoice(conversationId, elicitationId, choiceValue, onEvent)
            : respondToChatApproval(conversationId, elicitationId, approved === true, onEvent)
        : respondToToolCall(conversationId, toolCallId ?? "", approved === true);
    },
    onSuccess: async (_result, variables) => {
      const loaded = await loadTranscript(variables.conversationId);
      if (ownsOperation(variables.operation)) clearStream();
      if (!loaded)
        await queryClient.invalidateQueries({
          queryKey: ["conversation", variables.conversationId],
        });
    },
    onError: (_error, variables) =>
      queryClient.invalidateQueries({ queryKey: ["conversation", variables.conversationId] }),
    onSettled: async (_data, _error, variables) => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["conversations"] }),
          queryClient.invalidateQueries({ queryKey: ["decisions"] }),
          queryClient.invalidateQueries({ queryKey: ["attention"] }),
        ]);
      } finally {
        if (decisionLock.current === variables.operation) decisionLock.current = null;
      }
    },
  });
  const decidePending = decide.isPending && decide.variables?.operation.session === sessionKey;
  const submitApproval = (elicitationId: string, approved: boolean) => {
    if (
      (decisionLock.current && ownsOperation(decisionLock.current)) ||
      sendPending ||
      decidePending
    )
      return;
    const operation = beginOperation();
    decisionLock.current = operation;
    decide.mutate({
      elicitationId,
      approved,
      conversationId: activeId ?? "",
      operation,
    });
  };
  const submitChoice = (elicitationId: string, choiceValue: string) => {
    if (
      (decisionLock.current && ownsOperation(decisionLock.current)) ||
      sendPending ||
      decidePending
    )
      return;
    const operation = beginOperation();
    decisionLock.current = operation;
    send.reset();
    decide.mutate({
      elicitationId,
      choiceValue,
      conversationId: activeId ?? "",
      operation,
    });
  };
  const submitForm = (elicitationId: string, formOutput: Record<string, unknown>) => {
    if (
      (decisionLock.current && ownsOperation(decisionLock.current)) ||
      sendPending ||
      decidePending
    )
      return;
    const operation = beginOperation();
    decisionLock.current = operation;
    send.reset();
    decide.mutate({
      elicitationId,
      formOutput,
      conversationId: activeId ?? "",
      operation,
    });
  };
  const remove = useMutation({
    mutationFn: (target: Conversation) => deleteConversation(target.id),
    onSuccess: async (_result, target) => {
      setDeleteTarget(null);
      if (activeId === target.id) startNew();
      queryClient.removeQueries({ queryKey: ["conversation", target.id] });
      toast.success(t("chat.deleted", { title: target.title || t("chat.untitled") }));
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 409
          ? t("chat.delete.running")
          : t("common.actionFailed"),
      ),
  });
  const rename = useMutation({
    mutationFn: () => renameConversation(renameTarget?.id ?? "", renameTitle.trim()),
    onSuccess: async () => {
      const renamed = renameTarget?.id;
      setRenameTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        renamed ? queryClient.invalidateQueries({ queryKey: ["conversation", renamed] }) : null,
      ]);
    },
  });
  const current = detail.data?.conversation;
  const chatWorkspace = useChatWorkspace(Boolean(current));
  const [contextContainer] = useState(() => document.createElement("div"));
  const contextDock = useRef<HTMLElement>(null);
  const contextToggle = useRef<HTMLButtonElement>(null);
  const closeContext = () => {
    chatWorkspace.setOpen(false);
    contextToggle.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const dock = contextDock.current;
    if (!dock) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeContext();
    };
    dock.addEventListener("keydown", dismiss);
    return () => dock.removeEventListener("keydown", dismiss);
  }, [chatWorkspace.docked, chatWorkspace.open, chatWorkspace.setOpen]);
  const attachContext = (host: HTMLDivElement | null) => {
    if (host && contextContainer.parentElement !== host) host.append(contextContainer);
  };
  const messages = detail.data?.messages ?? [];
  const resume = detail.data?.resume_summary;
  const playbook = detail.data?.playbook ?? null;
  const openQuestionId = resume?.pending_approval?.id ?? null;
  const seenQuestionId = useRef(openQuestionId);
  useEffect(() => {
    if (seenQuestionId.current === openQuestionId) return;
    seenQuestionId.current = openQuestionId;
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }, [openQuestionId, queryClient]);
  const pendingDecision = chatApproval(detail.data);
  const pendingChoice = chatChoice(detail.data);
  const pendingForm = useMemo(() => chatForm(detail.data), [detail.data]);
  const pendingText = useMemo(() => chatText(detail.data), [detail.data]);
  const [clock, setClock] = useState(Date.now);
  const lockingId =
    pendingDecision?.id ?? pendingChoice?.id ?? pendingForm?.id ?? pendingText?.id ?? null;
  useEffect(() => {
    if (!lockingId) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockingId]);
  const open = (question: { expiresAt: string } | null) =>
    question !== null && Date.parse(question.expiresAt) > clock;
  const choiceOpen = open(pendingChoice);
  const formOpen = open(pendingForm);
  const anyQuestion = Boolean(pendingDecision || pendingChoice || pendingForm || pendingText);
  const playbookQuestions = [pendingDecision, pendingChoice, pendingForm, pendingText].filter(
    (question): question is NonNullable<typeof question> => question !== null,
  );
  const playbookActionTargetFor = (action: PlaybookAction | null) =>
    busy ? null : playbookActionTarget(action, playbookQuestions, clock);
  const openPlaybookQuestion = (id: string) => {
    if (!playbookQuestions.some((question) => question.id === id && open(question))) return;
    const kind =
      pendingDecision?.id === id
        ? "approval"
        : pendingChoice?.id === id
          ? "choice"
          : pendingForm?.id === id
            ? "form"
            : "text";
    chatWorkspace.setOpen(false);
    requestAnimationFrame(() => {
      const target =
        kind === "text"
          ? document.querySelector<HTMLElement>('[data-testid="chat-composer-input"]')
          : document.querySelector<HTMLElement>(
              `[data-testid="chat-${kind}"], [data-testid^="chat-message-"][data-testid$="-${kind}"]`,
            );
      target?.scrollIntoView({ block: "center" });
      if (target && kind !== "text") target.setAttribute("tabindex", "-1");
      target?.focus();
    });
  };
  const showPlaybookDetails = () => {
    chatWorkspace.setOpen(true);
    requestAnimationFrame(() => contextContainer.querySelector<HTMLElement>("summary")?.focus());
  };
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
  const latestPreviewCallId = useMemo(() => latestDryRunCallId(messages), [messages]);
  const savedPreviews = useMemo(
    () => savedSensitivePreviews(detail.data?.tool_calls ?? []),
    [detail.data],
  );
  const nameFor = useMemo(() => {
    const known = new Map<string, ResolvedIdentifier>();
    for (const conversation of conversationList.items) {
      if (!conversation.title) continue;
      known.set(conversation.id, {
        label: humanFacingText(conversation.title, t("chat.referenceUnnamed")),
        href: absolute(conversationHref(conversation.id)),
      });
    }
    for (const resource of namedResources({
      target: resume?.active_target,
      created: createdResources,
      referenced: referencedResources,
    }).values())
      known.set(resource.id, {
        label: resource.label,
        href: catalogHref(resource.kind, resource.id),
      });
    return (id: string) => known.get(id) ?? null;
  }, [conversationList.items, createdResources, referencedResources, resume?.active_target, t]);
  const session = useSession();
  const live = useLiveQueryOptions();
  const conversationFiles = useQuery({
    queryKey: ["conversation-attachments", activeId],
    enabled: Boolean(activeId),
    queryFn: () => listConversationAttachments(activeId ?? ""),
    ...live,
  });
  const attachmentFor = useMemo(() => {
    const byId = new Map(
      (conversationFiles.data?.attachments ?? []).map((file) => [file.id, file] as const),
    );
    return (fileId: string) => byId.get(fileId) ?? null;
  }, [conversationFiles.data]);
  const openStoredFile = (fileId: string) => {
    const linked = attachmentFor(fileId);
    setPreview({
      name: linked?.filename ?? t("chat.attachment.file"),
      size: linked?.size_bytes,
      contentType: linked?.content_type,
      fileId,
    });
  };
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
  const reviewCards = useMemo(
    () =>
      liveAutomationReviews(
        messages.flatMap((message) =>
          groupMessageParts(message.parts).flatMap((group) =>
            group.kind === "tool" ? [group.tool] : group.kind === "background" ? group.tools : [],
          ),
        ),
      ),
    [messages],
  );
  const liveReviewCalls = useMemo(() => new Set(reviewCards.values()), [reviewCards]);
  const nextActionSaid =
    anyQuestion || resume?.stage === "workflow_saved" || !resume
      ? null
      : resumeNextAction(resume.stage, t);
  const nextAction = nextActionSaid === t("chat.context.continue") ? null : nextActionSaid;
  const automationStatus = useQuery({
    queryKey: ["workflow-automation-status", targetWorkflowId],
    enabled: Boolean(targetWorkflowId && session.permissions.includes("schedule:read")),
    queryFn: () =>
      apiRequest<{
        schedules: { ready: boolean; next_run_at: string | null; timezone: string }[];
        inbound_hooks?: { ready: boolean }[];
      }>(`/v1/workflows/${encodeURIComponent(targetWorkflowId!)}/automation-status`),
    ...live,
  });
  const readySchedules =
    automationStatus.data?.schedules?.filter((schedule) => schedule.ready) ?? [];
  const readyAutomations =
    readySchedules.length +
    (automationStatus.data?.inbound_hooks?.filter((hook) => hook.ready).length ?? 0);
  const status = sendPending || decidePending ? "streaming" : "ready";
  const ordered = useMemo(
    () => [...conversationList.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [conversationList.items],
  );
  const activeRow = ordered.find((conversation) => conversation.id === activeId) ?? null;
  const origin = current
    ? originLine(t, locale, {
        surface: current.surface,
        client: current.origin_client ?? null,
        owner: detail.data?.owner ?? null,
        viewerId: session.principal.id ?? null,
        at: activeRow?.last_activity_at ?? current.updated_at,
      })
    : "";
  const waitsForYou = waitsForPerson({
    questions: [pendingDecision, pendingChoice, pendingForm, pendingText],
    now: clock,
    pendingApproval: resume?.pending_approval ?? null,
    detailLoaded: detail.data !== undefined,
    rowOutcome: activeRow?.outcome,
  });
  const badge =
    sendPending || decidePending
      ? { label: t("chat.outcome.in_progress"), state: "running" }
      : waitsForYou
        ? { label: t("chat.outcome.awaiting_you"), state: "awaiting_input" }
        : resume?.stage === "workflow_saved"
          ? { label: t("chat.resume.stage.workflowSaved"), state: "committed" }
          : null;
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
  const conversationFailed = Boolean(activeId) && queryView(detail, () => false) === "error";
  const conversationMissing =
    conversationFailed &&
    conversationFailureKind(detail.error ?? detail.failureReason) === "missing";
  const playbookAnchor = playbook
    ? playbookAnchorIndex(messages, playbook, detail.data?.tool_calls ?? [])
    : null;
  const playbookAnchorMessage = playbookAnchor === null ? null : messages[playbookAnchor];
  const playbookPlacement = {
    inlineIndex:
      playbookAnchor !== null &&
      (playbookAnchorMessage?.role === "assistant" || playbookAnchor < messages.length - 1)
        ? playbookAnchor
        : null,
    atEnd:
      playbookAnchor === null
        ? !messages.some((message) => message.role === "assistant")
        : playbookAnchor === messages.length - 1 && playbookAnchorMessage?.role !== "assistant",
  };
  const playbookSummary =
    playbook && !conversationFailed && playbookSummaryVisible(chatWorkspace.open) ? (
      <MessageScrollerItem key={`playbook-${playbook.id}`}>
        <ChatPlaybookSummary
          playbook={playbook}
          actionTarget={playbookActionTargetFor}
          onOpenQuestion={openPlaybookQuestion}
          onShowDetails={showPlaybookDetails}
          refreshing={sendPending || decidePending}
          refreshFailed={detail.isRefetchError}
        />
      </MessageScrollerItem>
    ) : null;
  const listFailed = queryView(conversations, () => false) === "error";
  const storedMode = detail.data ? storedAuthoringMode(detail.data.draft) : "loading";
  const composerHint = choiceOpen
    ? { text: t("chat.choice.hint"), visible: true }
    : formOpen
      ? null
      : pendingText && !sendPending
        ? {
            text: t("chat.text.composerHint", { question: questionExcerpt(pendingText.question) }),
            visible: true,
          }
        : null;
  const anchoredCalls = useMemo(
    () =>
      new Set(
        messages.flatMap((message) =>
          groupMessageParts(message.parts).flatMap((group) =>
            group.kind === "tool"
              ? [group.tool.toolCallId]
              : group.kind === "background"
                ? group.tools.map((tool) => tool.toolCallId)
                : [],
          ),
        ),
      ),
    [messages],
  );
  const unanchored = <T extends { toolCallId: string }>(question: T | null): T | null =>
    question && !anchoredCalls.has(question.toolCallId) ? question : null;
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
  const summaryLine = conversationFailed
    ? null
    : resumeSummaryLine(resume, t, (iso) => formatDateTime(locale, iso));
  const showOptimistic = optimisticVisible(optimistic, sessionKey, messages);
  const canReadStats = session.permissions.includes("stats:read");
  const monthStatus = useQuery({
    queryKey: ["usage-status"],
    enabled: canReadStats,
    queryFn: () => apiRequest<unknown>("/v1/status"),
  });
  const budget = budgetPill(budgetPressure(budgetSummary(monthStatus.data)));
  const busy = sendPending || decidePending;
  const showPreparation = Boolean(
    resume?.unsaved &&
      resume?.stage !== "workflow_draft_conflict" &&
      targetWorkflowId &&
      !anyQuestion &&
      status === "ready",
  );
  const showDraftConflict = Boolean(
    resume?.stage === "workflow_draft_conflict" &&
      targetWorkflowId &&
      !anyQuestion &&
      status === "ready",
  );
  const liveTest = resume?.live_test ?? null;
  const showScheduleStep = Boolean(
    heldTarget &&
      !resume?.unsaved &&
      targetWorkflowId &&
      !reviewCards.has(targetWorkflowId) &&
      !anyQuestion &&
      status === "ready",
  );
  const showProdLiveTest = Boolean(
    resume?.active_target.environment === "prod" &&
      !heldTarget &&
      !resume?.unsaved &&
      !liveTest &&
      readyAutomations > 0 &&
      targetWorkflowId &&
      !anyQuestion &&
      status === "ready",
  );
  const unanchoredDecision = unanchored(pendingDecision);
  const unanchoredChoice = unanchored(pendingChoice);
  const unanchoredForm = unanchored(pendingForm);
  const decisionErrorFor = (id: string | undefined) =>
    decide.isError &&
    decide.variables?.operation.session === sessionKey &&
    decide.variables?.elicitationId === id;
  const menuItems =
    current && !conversationFailed
      ? [
          {
            label: t("chat.rename"),
            testId: "chat-rename",
            onSelect: () => {
              setRenameTarget(current);
              setRenameTitle(current.title || t("chat.untitled"));
            },
          },
          {
            label: t("chat.delete"),
            testId: "chat-delete",
            destructive: true,
            onSelect: () => setDeleteTarget(current),
          },
        ]
      : [];
  const headerText =
    headerTitle.kind === "title"
      ? headerTitle.text
      : headerTitle.kind === "loading"
        ? " "
        : t(
            headerTitle.kind === "unavailable"
              ? "chat.unavailable"
              : headerTitle.kind === "untitled"
                ? "chat.untitled"
                : "chat.new",
          );
  const chatHeader = <PageHeader testId="chat-header" title={t("nav.chat")} />;
  const newConversation = (
    <Button
      variant="default"
      onClick={startNew}
      className="md:w-full"
      data-testid="conversation-new"
    >
      {t("chat.new")}
    </Button>
  );
  const conversationHead = (
    <div className="py-3 md:pt-6 md:pb-0" data-testid="chat-conversation-head">
      <div className="flex min-h-8 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          data-testid="chat-title"
          title={headerText}
        >
          {headerText}
        </span>
        {current && badge ? (
          <span className="hidden sm:inline-flex">
            <StatusBadge state={badge.state} label={badge.label} testId="chat-status" />
          </span>
        ) : null}
        <Button
          variant="ghost"
          className="md:hidden"
          aria-expanded={listOpen}
          aria-controls="chat-conversation-list"
          onClick={() => setListOpen((value) => !value)}
          data-testid="conversation-list-trigger"
        >
          {t("chat.conversations")}
        </Button>
        <IconButton
          label={t(playbook ? "chat.playbook.title" : "chat.toggleContext")}
          ref={contextToggle}
          data-testid="chat-context-toggle"
          aria-expanded={chatWorkspace.open}
          aria-controls={chatContextControlsTarget(chatWorkspace.open, Boolean(current))}
          disabled={!current}
          onClick={() => chatWorkspace.setOpen(!chatWorkspace.open)}
        >
          {playbook ? <BookOpen /> : <PanelRight />}
        </IconButton>
        {menuItems.length > 0 ? <ActionMenu items={menuItems} testId="chat-menu" /> : null}
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
      infinite={conversationList.infinite}
      activeId={activeId}
      showHidden={showHidden}
      hasHidden={(hiddenConversations.data?.items.length ?? 0) > 0}
      onToggleHidden={() => setShowHidden((value) => !value)}
      onSelect={(id) => {
        setSelection({ kind: "existing", id });
        navigate("select", false);
        setChatPath(id);
        setListOpen(false);
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
  const blocked = sendError instanceof ApiError && sendError.code === "pending_elicitation_blocked";
  const target = resume?.active_target;
  const targetNamed = Boolean(target && target.kind !== "none" && (target.name || target.kind));
  const contextFacts: Fact[] = [
    ...(current && origin
      ? [{ label: t("chat.context.origin"), value: origin, testId: "chat-origin" }]
      : []),
    ...(anyQuestion
      ? []
      : [
          {
            label: t("chat.context.stage"),
            value: decidePending
              ? t("chat.decision.processing")
              : resumeStageLabel(resume?.stage, t),
            help: resume?.one_sentence
              ? hideTechnicalIdentifiers(resume.one_sentence, t("tool.referenceHiddenInline"))
              : undefined,
            testId: "chat-context-stage",
          },
        ]),
    ...(targetNamed
      ? [
          {
            label: t("chat.context.target"),
            value: localizedTarget(target?.name || target?.kind, t),
            testId: "chat-context-target",
          },
        ]
      : []),
    ...(nextAction
      ? [
          {
            label: t("chat.context.nextAction"),
            value: nextAction,
            testId: "chat-context-next-action",
          },
        ]
      : []),
    ...(heldTarget && targetWorkflowId && !showScheduleStep
      ? [
          {
            label: t(heldScheduleCopy(heldTarget).title),
            value: (
              <span className="flex flex-col items-start gap-2">
                <span>{t(heldScheduleCopy(heldTarget).line)}</span>
                <HeldScheduleAction
                  schedule={heldTarget}
                  conversationId={activeId ?? undefined}
                  workflowId={targetWorkflowId}
                  testId="chat-context-review-schedule"
                  busy={status !== "ready"}
                  onPrepareSingleRun={() => {
                    chatWorkspace.setOpen(false);
                    void submitTurn(t("chat.activation.singlePrompt"));
                  }}
                  onRepair={() => {
                    chatWorkspace.setOpen(false);
                    void submitTurn(t("authority.adjustPrompt"));
                  }}
                />
              </span>
            ),
            testId: "chat-context-held-schedule",
          },
        ]
      : []),
    ...(current
      ? [
          {
            label: t("chat.context.checkpoint"),
            value: t(resume?.unsaved ? "chat.context.unsaved" : "chat.context.saved"),
            testId: "chat-context-checkpoint",
          },
        ]
      : []),
    ...(resume?.pending_approval && !anyQuestion
      ? [
          {
            label: t("chat.context.approval"),
            value: approvalLine(
              pendingApprovalSubject(resume.pending_approval, resume.active_target.name),
              t,
              (text) => hideTechnicalIdentifiers(text, t("tool.referenceHiddenInline")),
            ),
            testId: "chat-context-approval",
          },
        ]
      : []),
  ];
  const references = referencedResources;
  if (references.length > 0)
    contextFacts.push({
      label: t("chat.context.references"),
      testId: "chat-context-references",
      value: (
        <ul className="grid gap-1.5">
          {references.map((resource, index) => (
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
                {resource.unresolved
                  ? t("chat.context.referenceUnavailable")
                  : `${t(`chat.created.kind.${resource.type}`)} · ${formatRelativeTime(locale, resource.at)}`}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  if (createdResources.length > 0)
    contextFacts.push({
      label: t("chat.created.title"),
      testId: "chat-context-created",
      value: (
        <ul className="grid gap-1">
          {createdResources.map((resource, index) => (
            <li key={`${resource.kind}-${resource.id}`} className="flex items-baseline gap-2">
              <a
                className="truncate underline-offset-4 hover:underline"
                href={catalogHref(resource.kind, resource.id)}
                data-testid={`chat-context-created-${index}`}
              >
                {resource.name || resource.slug || t(`chat.created.kind.${resource.kind}`)}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(`chat.created.kind.${resource.kind}`)} ·{" "}
                {formatRelativeTime(locale, resource.at)}
              </span>
            </li>
          ))}
        </ul>
      ),
    });

  const dropFiles = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (conversationFailed || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (conversationFailed || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDragging(false);
      const taken = takeAttachmentFiles([...event.dataTransfer.files], t);
      if (taken.length > 0) setAttachments((current) => addAttachments(current, taken));
    },
  };

  const contextContent = (
    <div id="chat-context-content" className="min-w-0">
      {playbook ? (
        <>
          <ChatPlaybookPanel
            key={playbook.id}
            playbook={playbook}
            actionTarget={playbookActionTargetFor}
            onOpenQuestion={openPlaybookQuestion}
          />
          {detail.isRefetchError ? (
            <StatusStrip tone="warn" line={t("chat.playbook.refreshFailed")} />
          ) : null}
          {contextFacts.length > 0 ? (
            <details className="mt-5 border-t pt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("chat.playbook.context")}
              </summary>
              <div className="pt-3">
                <FactList items={contextFacts} testId="chat-context-facts" />
              </div>
            </details>
          ) : null}
        </>
      ) : contextFacts.length > 0 ? (
        <FactList items={contextFacts} testId="chat-context-facts" />
      ) : (
        <DataState state="empty" line={t("chat.context.empty")} testId="chat-context-empty" />
      )}
    </div>
  );

  return (
    <Page kind="workspace" scroll="content" testId="chat-workspace" header={null}>
      <div
        ref={chatWorkspace.ref}
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          chatWorkspace.horizontal ? "flex-row" : "flex-col",
        )}
        data-testid="chat-layout"
      >
        <aside
          className={cn(
            "min-h-0 shrink-0 px-4",
            chatWorkspace.horizontal
              ? "flex w-66 flex-col items-stretch border-r"
              : "grid grid-cols-[minmax(0,1fr)_auto] items-center border-b",
          )}
          data-testid="chat-list-panel"
        >
          <div className={cn(chatWorkspace.horizontal && "-mx-4 h-18 border-b px-2")}>
            {chatHeader}
          </div>
          {newConversation ? (
            <div className={cn(chatWorkspace.horizontal && "-mx-2 pt-2")}>{newConversation}</div>
          ) : null}
          <section
            id="chat-conversation-list"
            aria-label={t("chat.conversations")}
            className={cn(
              "col-span-2 -mx-2 min-h-0 flex-1 flex-col pt-2 pb-4",
              listOpen
                ? cn("flex max-h-[40dvh]", chatWorkspace.horizontal && "max-h-none")
                : chatWorkspace.horizontal
                  ? "flex"
                  : "hidden",
            )}
          >
            {list}
          </section>
        </aside>
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            dragging && "bg-accent/5 outline-2 -outline-offset-2 outline-dashed outline-accent",
          )}
          data-testid="chat-main"
          data-dragging={dragging ? "true" : undefined}
          {...dropFiles}
        >
          <ReadingColumn
            testId="chat-header-column"
            className={cn("shrink-0 border-b", chatWorkspace.horizontal && "h-18")}
          >
            {conversationHead}
          </ReadingColumn>
          {summaryLine ? (
            <ReadingColumn className="pt-2">
              <p className="truncate text-xs text-muted-foreground" data-testid="chat-summary">
                {summaryLine}
              </p>
            </ReadingColumn>
          ) : null}
          {(send.error || turnFailure) && (
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

          {decide.isError && !pendingDecision && !pendingChoice && !pendingForm && (
            <ReadingColumn className="pb-3">
              <StatusStrip
                tone="error"
                testId="chat-decision-error"
                line={t("chat.decision.failed")}
              />
            </ReadingColumn>
          )}
          <MessageScrollerProvider key={sessionKey} autoScroll>
            <FollowSubmittedTurn submittedAt={Math.max(send.submittedAt, decide.submittedAt)} />
            <MessageScroller className="h-0 min-h-0 flex-1" data-testid="chat-transcript">
              <MessageScrollerViewport
                className="px-4 py-6 sm:px-6"
                style={{ scrollbarGutter: "stable" }}
              >
                <MessageScrollerContent className={CHAT_COLUMN}>
                  {conversationFailed ? (
                    <DataState
                      state="error"
                      line={t(conversationMissing ? "chat.notFound" : "chat.loadFailed")}
                      onRetry={conversationMissing ? undefined : () => void detail.refetch()}
                      testId="chat-load-failed"
                    />
                  ) : messages.length === 0 && !sendPending && !showOptimistic ? (
                    <div className="flex flex-1 py-6" data-testid="chat-empty">
                      {selection.kind === "new" && initialPrompt ? (
                        <p className="text-sm text-muted-foreground">{t("chat.empty.title")}</p>
                      ) : (
                        <ChatStart onPick={fillComposer} />
                      )}
                    </div>
                  ) : (
                    messages.map((message, index) => (
                      <Fragment key={message.id}>
                        <MessageScrollerItem>
                          <ChatMessage
                            conversationId={activeId ?? undefined}
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
                            answersQuestion={answerMessageIds.has(message.id)}
                            approvalBusy={busy}
                            approvalError={decisionErrorFor(
                              pendingDecision?.id ??
                                pendingChoice?.id ??
                                pendingForm?.id ??
                                pendingText?.id,
                            )}
                            onApproval={submitApproval}
                            nameFor={nameFor}
                            workflowNameFor={workflowNameFor}
                            attachmentFor={attachmentFor}
                            onOpenFile={openStoredFile}
                            liveReviews={liveReviewCalls}
                            onAutomationAdjust={(workflowId) =>
                              void submitTurn(t("authority.adjustPrompt"), [
                                {
                                  type: "workflow",
                                  id: workflowId,
                                  label: t("chat.singleRun.thisWorkflow"),
                                },
                              ])
                            }
                            onAutomationSingleRun={(workflowId) =>
                              void submitTurn(t("chat.activation.singlePrompt"), [
                                {
                                  type: "workflow",
                                  id: workflowId,
                                  label: t("chat.singleRun.thisWorkflow"),
                                },
                              ])
                            }
                            latestPreviewCallId={latestPreviewCallId}
                            savedPreviews={savedPreviews}
                            onInstruction={(instruction) =>
                              void submitTurn(instruction.message, instruction.references)
                            }
                            onReauth={(action) =>
                              void submitTurn(t("chat.reauth.prompt"), [
                                {
                                  type: "connector",
                                  id: action.connectorId,
                                  label: action.label || t("chat.reauth.title"),
                                },
                              ])
                            }
                            onDecision={(toolCallId, approved) =>
                              decide.mutate({
                                toolCallId,
                                approved,
                                conversationId: activeId ?? "",
                                operation: beginOperation(),
                              })
                            }
                          />
                        </MessageScrollerItem>
                        {index === playbookPlacement.inlineIndex ? playbookSummary : null}
                      </Fragment>
                    ))
                  )}
                  {showOptimistic && optimistic ? (
                    <MessageScrollerItem key="optimistic" data-testid="chat-pending-message">
                      <ChatMessage
                        conversationId={activeId ?? undefined}
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
                        onAutomationSingleRun={() => {}}
                        onInstruction={() => {}}
                        liveReviews={NO_LIVE_REVIEWS}
                        nameFor={nameFor}
                        workflowNameFor={workflowNameFor}
                      />
                    </MessageScrollerItem>
                  ) : null}
                  {liveCalls.length > 0 && (
                    <MessageScrollerItem>
                      <div
                        className="grid gap-1"
                        data-testid="chat-live-calls"
                        data-tick={liveTick}
                      >
                        {liveCalls.map((call, index) => {
                          const running = elapsedMs(call, Date.now());
                          return (
                            <div
                              key={call.callId}
                              className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground"
                              data-action-scope="live-call"
                              data-testid={`chat-live-call-${index}`}
                            >
                              <span className="font-medium">
                                {call.toolName ? actionLabel(t, call.toolName) : t("tool.action")}
                              </span>
                              {call.logTail && (
                                <details className="min-w-0 w-full">
                                  <summary>{t("chat.activity.details")}</summary>
                                  <CodeBlock code={call.logTail} />
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
                  {playbookPlacement.atEnd ? playbookSummary : null}
                  <MessageScrollerItem data-testid="chat-next-action">
                    {unanchoredDecision && (
                      <ChatApprovalCard
                        approval={unanchoredDecision}
                        conversationId={activeId ?? undefined}
                        busy={busy}
                        error={decisionErrorFor(unanchoredDecision.id)}
                        onDecision={submitApproval}
                        testId="chat-approval"
                      />
                    )}
                    {unanchoredChoice && (
                      <ChatChoiceCard
                        choice={unanchoredChoice}
                        busy={busy}
                        error={decisionErrorFor(unanchoredChoice.id)}
                        onAnswer={submitChoice}
                        testId="chat-choice"
                      />
                    )}
                    {unanchoredForm && (
                      <ChatFormCard
                        form={unanchoredForm}
                        busy={busy}
                        error={decisionErrorFor(unanchoredForm.id)}
                        onAnswer={submitForm}
                        testId="chat-form"
                      />
                    )}
                    {showPreparation && (
                      <ChatCard
                        testId="chat-preparation-next-step"
                        title={t("chat.preparation.title")}
                        line={t("chat.preparation.effect")}
                        action={
                          <Button
                            onClick={() => void submitTurn(t("chat.preparation.prompt"))}
                            data-testid="chat-continue-preparation"
                          >
                            {t("chat.preparation.continue")}
                          </Button>
                        }
                      />
                    )}
                    {showDraftConflict && (
                      <ChatCard
                        testId="chat-draft-conflict-next-step"
                        title={t("chat.draftConflict.title")}
                        line={t("chat.draftConflict.effect")}
                        action={
                          <Button
                            onClick={() => void submitTurn(t("chat.draftConflict.prompt"))}
                            data-testid="chat-reconcile-draft-conflict"
                          >
                            {t("chat.draftConflict.continue")}
                          </Button>
                        }
                      />
                    )}
                    {liveTest && (
                      <ChatCard
                        testId="chat-live-test-result"
                        title={t("chat.liveTest.title")}
                        line={t(`chat.liveTest.${liveTestState(liveTest.status)}`)}
                        action={
                          <Button asChild variant="outline">
                            <a
                              href={absolute(runHref(liveTest.execution_id))}
                              data-testid="chat-live-test-run"
                            >
                              {t("chat.liveTest.openRun")}
                            </a>
                          </Button>
                        }
                      />
                    )}

                    {showScheduleStep && heldTarget && targetWorkflowId && (
                      <ChatCard
                        testId="chat-schedule-next-step"
                        title={t(heldScheduleCopy(heldTarget).title)}
                        line={t(heldScheduleCopy(heldTarget).line)}
                        action={
                          <HeldScheduleAction
                            schedule={heldTarget}
                            conversationId={activeId ?? undefined}
                            workflowId={targetWorkflowId}
                            testId="chat-review-schedule"
                            busy={status !== "ready"}
                            onPrepareSingleRun={() =>
                              void submitTurn(t("chat.activation.singlePrompt"))
                            }
                            onRepair={() => void submitTurn(t("authority.adjustPrompt"))}
                          />
                        }
                      />
                    )}
                    {showProdLiveTest && (
                      <ChatCard
                        testId="chat-live-test-next-step"
                        title={t("chat.liveTest.prepareTitle")}
                        line={t("chat.liveTest.prepareEffect")}
                        action={
                          <Button
                            onClick={() => void submitTurn(t("chat.activation.singlePrompt"))}
                            data-testid="chat-prepare-live-test"
                          >
                            {t("chat.liveTest.prepare")}
                          </Button>
                        }
                      />
                    )}

                    {!heldTarget &&
                      !resume?.unsaved &&
                      readyAutomations > 0 &&
                      status === "ready" && (
                        <StatusStrip
                          tone="ok"
                          testId="chat-automation-ready"
                          line={t("chat.automation.ready")}
                          help={t("chat.automation.readyHint")}
                          more={readySchedules
                            .filter((schedule) => schedule.next_run_at)
                            .map((schedule) =>
                              t("authority.report.next", {
                                time: new Intl.DateTimeFormat(locale, {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                  timeZone: schedule.timezone,
                                }).format(new Date(schedule.next_run_at as string)),
                                zone: schedule.timezone,
                              }),
                            )
                            .join(" · ")}
                        />
                      )}
                  </MessageScrollerItem>
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton
                direction="end"
                label={t("chat.scrollBottom")}
                data-testid="chat-scroll-bottom"
              />
            </MessageScroller>
          </MessageScrollerProvider>

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
              <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="chat-pills">
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
                  className={
                    composerHint.visible ? "mb-2 text-sm text-muted-foreground" : "sr-only"
                  }
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
                className="mt-2 flex flex-wrap items-center gap-1.5"
                data-testid="chat-usage-pills"
              >
                <UsagePills usage={activeId ? detail.data?.usage : null} budget={budget} />
              </div>
            </div>
          </div>
        </div>
        {chatWorkspace.docked && chatWorkspace.open ? (
          <aside
            ref={contextDock}
            className="flex min-h-0 shrink-0 flex-col border-l bg-background"
            style={{ width: chatWorkspace.dockWidth }}
            data-testid="chat-context"
            data-presentation="docked"
            aria-labelledby="chat-context-title"
          >
            <div className="flex h-18 shrink-0 items-center gap-2 border-b px-4">
              <SectionHeading
                id="chat-context-title"
                className="min-w-0 flex-1 text-sm font-semibold"
              >
                {t(playbook ? "chat.playbook.title" : "chat.context.title")}
              </SectionHeading>
              <IconButton
                label={t("common.close")}
                data-testid="chat-context-close"
                onClick={closeContext}
              >
                <X />
              </IconButton>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
              <div ref={attachContext} />
            </div>
          </aside>
        ) : null}
      </div>

      <AttachmentPreviewSheet preview={preview} onClose={() => setPreview(null)} />

      <RecordSheet
        open={!chatWorkspace.docked && chatWorkspace.open}
        onOpenChange={chatWorkspace.setOpen}
        title={t(playbook ? "chat.playbook.title" : "chat.context.title")}
        testId="chat-context"
        closeTestId="chat-context-close"
      >
        <div ref={attachContext} />
      </RecordSheet>
      {current || chatWorkspace.open ? createPortal(contextContent, contextContainer) : null}

      <FormDialog
        open={Boolean(renameTarget)}
        onOpenChange={(value) => !value && setRenameTarget(null)}
        title={t("chat.rename")}
        submit={{
          label: t("common.rename"),
          pending: rename.isPending,
          disabled: !renameTitle.trim(),
        }}
        onSubmit={() => rename.mutate()}
        testId="conversation-rename-dialog"
      >
        <Field>
          <FieldLabel htmlFor="conversation-rename-title">{t("resource.field.title")}</FieldLabel>
          <Input
            id="conversation-rename-title"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            data-testid="conversation-rename-title"
          />
        </Field>
      </FormDialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => !value && setDeleteTarget(null)}
        object={t("chat.delete.object")}
        verb={t("chat.delete.verb")}
        consequence={t("chat.delete.consequence", {
          title: deleteTarget?.title || t("chat.untitled"),
        })}
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget);
        }}
        testId="conversation-delete-dialog"
      />
    </Page>
  );
}
