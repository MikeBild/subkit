import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ApiError,
  type ConversationDetail,
  type ConversationReference,
  cancelConversation,
  getConversation,
  respondToChatApproval,
  respondToChatChoice,
  respondToChatForm,
  respondToToolCall,
  sendConversationTurn,
} from "@/api/client";
import { chatSeedFromUrl, chatTargetFromUrl } from "@/app/links";
import { usdFormatter } from "@/features/usage";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import {
  addAttachments,
  createEmptyConversation,
  linkAttachment,
  messageWithAttachments,
  type PendingAttachment,
  pendingKey,
} from "../api/attachments";
import { asStreamedDiff, type RestoreComposer, type StreamedDiff } from "../model/labels";
import { applyLiveCall, type LiveCall, reduceLiveCall } from "../model/live-calls";
import { LIVE_POLICY_KEY, livePolicy } from "../model/policy";
import { type ConversationSelection, pinSelectionForSend } from "../model/selection";
import {
  type ChatNavigation,
  type ChatOperation,
  conversationOpenedByFailedSend,
  nextSessionKey,
  type OptimisticMessage,
  ownsChatOperation,
  recoverFailedSend,
  spendNoticeOf,
  turnFailureCause,
  userMessageCount,
} from "../model/session";
import { type ClaimedFile, claimedAsPending } from "../model/tray-model";
import { selectionFromPath, setChatPath } from "./chat-path";
import { COMPOSER_TRAY_KEY, claimComposerTray } from "./tray";

type ClaimedChatOperation = ChatOperation & { claimed?: ClaimedFile[] };

export type ChatTurn = ReturnType<typeof useChatTurn>;

export function useChatTurn({
  selection,
  setSelection,
  firstListedId,
  activeId,
  detail,
  messages,
  attachments,
  setAttachments,
  restoreComposer,
}: {
  selection: ConversationSelection;
  setSelection: React.Dispatch<React.SetStateAction<ConversationSelection>>;
  firstListedId: string | undefined;
  activeId: string | null;
  detail: UseQueryResult<ConversationDetail, unknown>;
  messages: ConversationDetail["messages"];
  attachments: PendingAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  restoreComposer: React.RefObject<RestoreComposer | null>;
}) {
  const { t, locale } = useI18n();
  const usd = usdFormatter(locale);
  const queryClient = useQueryClient();
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
  const [sessionKey, setSessionKey] = useState(0);
  const [startedHere, setStartedHere] = useState(() => selection.kind === "new");
  const [optimistic, setOptimistic] = useState<OptimisticMessage | null>(null);
  const sessionRef = useRef(0);
  const operationRef = useRef<object | null>(null);
  const ownsOperation = (operation: ClaimedChatOperation) =>
    ownsChatOperation(operationRef.current, operation, sessionRef.current);
  const beginOperation = (): ClaimedChatOperation => {
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
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
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
    const ran = livePolicy(event);
    if (ran) {
      queryClient.setQueryData([LIVE_POLICY_KEY, ran.callId], ran.policy);
      return;
    }
    const live = reduceLiveCall(event);
    if (live) {
      setLiveCalls((calls) => applyLiveCall(calls, live));
      return;
    }
    const spent = spendNoticeOf(event);
    if (spent) {
      toast.info(
        t("chat.spendNotice", { amount: usd(spent.amount), threshold: usd(spent.threshold) }),
      );
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
      trayIds = [],
      operation,
    }: {
      message: string;
      references?: ConversationReference[];
      conversationId: string | null;
      operation: ClaimedChatOperation;
      attachments?: readonly PendingAttachment[];
      trayIds?: readonly string[];
    }) => {
      clearStream();

      const target = chatTargetFromUrl(window.location.search);
      const intakeItemIds = chatSeedFromUrl(window.location.search).intakeItemIds;
      let targetId = conversationId;
      let text = message;
      if (attachments.length > 0 || trayIds.length > 0) {
        if (!targetId) {
          const opened = await createEmptyConversation({
            target,
            intakeItemIds,
          });
          targetId = opened.id;
          operation.startedId = opened.id;
        }
        const slugs: string[] = [];
        for (const attachment of attachments)
          slugs.push(await linkAttachment(targetId, attachment));
        if (trayIds.length > 0) {
          try {
            const claimed = await claimComposerTray(targetId, trayIds);
            operation.claimed = claimed;
            slugs.push(...claimed.map((file) => file.slug));
          } finally {
            void queryClient.invalidateQueries({ queryKey: COMPOSER_TRAY_KEY });
          }
        }
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
    trayIds: readonly string[] = [],
  ): Promise<boolean> => {
    const operation = beginOperation();
    const pinned = pinSelectionForSend(selection, firstListedId);
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
    const sentAttachments = attachments;
    setAttachments([]);
    try {
      await send.mutateAsync({
        message,
        references,
        conversationId: targetId,
        attachments: sentAttachments,
        trayIds,
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
      setAttachments((current) =>
        addAttachments(
          addAttachments(sentAttachments, claimedAsPending(operation.claimed ?? [], pendingKey)),
          current,
        ),
      );
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
    mutationFn: (id: string) => cancelConversation(id),
    onSuccess: (_result, id) => queryClient.invalidateQueries({ queryKey: ["conversation", id] }),
  });
  const decisionLock = useRef<ClaimedChatOperation | null>(null);
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
      operation: ClaimedChatOperation;
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
  return {
    streamedText,
    streamedDiffs,
    liveCalls,
    liveTick,
    anyLive,
    sessionKey,
    startedHere,
    optimistic,
    beginOperation,
    navigate,
    send,
    sendPending,
    sendError,
    turnFailure,
    turnFailureMessage,
    failureCauseText,
    submitTurn,
    retryTurn,
    cancel,
    decide,
    decidePending,
    submitApproval,
    submitChoice,
    submitForm,
  };
}
