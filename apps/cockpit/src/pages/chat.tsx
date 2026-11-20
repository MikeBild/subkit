import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiCall } from "@/api/call";
import { type Conversation, getConversation, OWN_CONVERSATIONS } from "@/api/client";
import { chatSeedFromUrl } from "@/app/links";
import { useSession } from "@/app/session";
import { useHeldSchedules } from "@/app/use-decisions";
import { MessageScrollerItem, Page } from "@/components/cockpit/patterns";
import { queryView } from "@/components/failure-state";
import {
  type AttachmentPreview,
  AttachmentPreviewSheet,
  ChatComposerArea,
  ChatContextContent,
  ChatContextDock,
  ChatContextSheet,
  ChatListPanel,
  ChatTranscript,
  ConversationDialogs,
  ConversationHead,
  originLine,
  QuestionDock,
  ReadingColumn,
  type RestoreComposer,
  selectionFromPath,
  setChatPath,
  TaskRunLine,
  TurnErrors,
  useContextDock,
  useConversationDialogs,
  useRunOfConversation,
} from "@/features/chat";
import { formatDateTime } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { humanFacingText } from "@/lib/presentation";
import { useInfiniteList } from "@/lib/use-infinite-list";
import { cn } from "@/lib/utils";
import { conversationRefreshInterval, waitsForPerson } from "./chat-approval";
import { addAttachments, type PendingAttachment, takeAttachmentFiles } from "./chat-attachments";
import { useNewChatMode } from "./chat-default-mode";
import { conversationFailureKind, retryConversationRead } from "./chat-load-failure";
import { useChatLookups } from "./chat-lookups";
import { modeLabelKey } from "./chat-mode";
import { type AuthoringMode, storedAuthoringMode } from "./chat-permission";
import {
  type PlaybookAction,
  playbookActionTarget,
  playbookAnchorIndex,
  playbookSummaryVisible,
} from "./chat-playbook";
import { ChatPlaybookSummary } from "./chat-playbook-panel";
import { useChatQuestions } from "./chat-questions";
import { resumeNextAction, resumeSummaryLine } from "./chat-resume";
import { activeConversationId, type ConversationSelection } from "./chat-selection";
import { budgetPill, chatHeaderTitle, optimisticVisible } from "./chat-session";
import { runMarker, runPlaybook } from "./chat-task-run";
import { questionExcerpt } from "./chat-text";
import { useChatTurn } from "./chat-turn";
import { useChatWorkspace } from "./chat-workspace";
import { budgetPressure, budgetSummary } from "./usage-model";

export function ChatPage() {
  const { t, locale } = useI18n();
  const initialPrompt = chatSeedFromUrl(window.location.search).prompt;
  const [selection, setSelection] = useState<ConversationSelection>(() =>
    selectionFromPath(initialPrompt),
  );
  const [showHidden, setShowHidden] = useState(false);
  const [newPermissionMode, setNewPermissionMode, resetNewPermissionMode] = useNewChatMode();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [dragging, setDragging] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const restoreComposer = useRef<RestoreComposer | null>(null);
  const conversationList = useInfiniteList<Conversation>(
    "/v1/conversations",
    { ...OWN_CONVERSATIONS, ...(showHidden ? { hidden: "only" } : {}) },
    { queryKey: ["conversations", "infinite", showHidden ? "hidden" : "visible"] },
  );
  const hiddenConversations = useQuery({
    queryKey: ["conversations", "hidden-presence"],
    queryFn: () =>
      apiCall("get", "/v1/conversations", {
        query: { ...OWN_CONVERSATIONS, hidden: "only", limit: 1 },
      }),
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
  const messages = detail.data?.messages ?? [];
  const turn = useChatTurn({
    selection,
    setSelection,
    firstListedId: conversationList.items[0]?.id,
    activeId,
    detail,
    messages,
    newPermissionMode,
    attachments,
    setAttachments,
    restoreComposer,
  });
  const { sessionKey, sendPending, decidePending, decide, submitTurn } = turn;
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
  const dialogs = useConversationDialogs({ activeId, startNew: () => startNew() });
  const current = detail.data?.conversation;
  const chatWorkspace = useChatWorkspace(Boolean(current));
  const contextDock = useContextDock(chatWorkspace);
  const resume = detail.data?.resume_summary;
  const run = detail.data ? runMarker(detail.data.draft) : null;
  const storedPlaybook = detail.data?.playbook ?? null;
  const questions = useChatQuestions(detail.data);
  const { pendingDecision, pendingChoice, pendingForm, pendingText, clock, open } = questions;
  const { choiceOpen, formOpen, anyQuestion, playbookQuestions } = questions;
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
    requestAnimationFrame(() =>
      contextDock.contextContainer.querySelector<HTMLElement>("summary")?.focus(),
    );
  };
  const lookups = useChatLookups({
    activeId,
    data: detail.data,
    messages,
    conversations: conversationList.items,
  });
  const { createdResources, referencedResources, attachmentFor, reviewCards, live } = lookups;
  const openStoredFile = (fileId: string) => {
    const linked = attachmentFor(fileId);
    setPreview({
      name: linked?.filename ?? t("chat.attachment.file"),
      size: linked?.size_bytes,
      contentType: linked?.content_type,
      fileId,
    });
  };
  const session = useSession();
  const runState = useRunOfConversation(run?.taskRunId ?? "", session.permissions).data?.state;
  const playbook =
    storedPlaybook && run ? runPlaybook(storedPlaybook, t, runState) : storedPlaybook;
  const heldSchedules = useHeldSchedules(session.permissions);
  const targetWorkflowId =
    !run && resume?.active_target.kind === "workflow" ? resume.active_target.id : null;
  const heldTarget = heldSchedules.find((schedule) => schedule.workflow_id === targetWorkflowId);
  const nextActionSaid =
    anyQuestion || resume?.stage === "workflow_saved" || !resume
      ? null
      : resumeNextAction(resume.stage, t);
  const nextAction = nextActionSaid === t("chat.context.continue") ? null : nextActionSaid;
  const automationStatus = useQuery({
    queryKey: ["workflow-automation-status", targetWorkflowId],
    enabled: Boolean(targetWorkflowId && session.permissions.includes("schedule:read")),
    queryFn: () =>
      apiCall("get", "/v1/workflows/{id}/automation-status", {
        path: { id: targetWorkflowId ?? "" },
      }),
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
    turn.navigate("startNew", true);
    resetNewPermissionMode();
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
  const storedConcrete: AuthoringMode | null =
    storedMode === "auto" || storedMode === "ask" || storedMode === "plan" ? storedMode : null;
  const pillMode: AuthoringMode | null = !activeId
    ? newPermissionMode
    : (storedConcrete ?? (storedMode === "loading" ? turn.sentMode : null));
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
    startedHere: turn.startedHere,
    loaded: Boolean(detail.data),
  });
  const summaryLine = conversationFailed
    ? null
    : resumeSummaryLine(resume, t, (iso) => formatDateTime(locale, iso));
  const showOptimistic = optimisticVisible(turn.optimistic, sessionKey, messages);
  const canReadStats = session.permissions.includes("stats:read");
  const monthStatus = useQuery({
    queryKey: ["usage-status"],
    enabled: canReadStats,
    queryFn: () => apiCall("get", "/v1/status", {}),
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
              dialogs.setRenameTarget(current);
              dialogs.setRenameTitle(current.title || t("chat.untitled"));
            },
          },
          {
            label: t("chat.delete"),
            testId: "chat-delete",
            destructive: true,
            onSelect: () => dialogs.setDeleteTarget(current),
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
        <ChatListPanel
          horizontal={chatWorkspace.horizontal}
          listOpen={listOpen}
          onNew={startNew}
          list={{
            failed: listFailed
              ? { title: t("chat.list.loadFailed"), onRetry: () => void conversations.refetch() }
              : null,
            conversations: listRows,
            infinite: conversationList.infinite,
            activeId,
            showHidden,
            hasHidden: (hiddenConversations.data?.items.length ?? 0) > 0,
            onToggleHidden: () => setShowHidden((value) => !value),
            onSelect: (id) => {
              setSelection({ kind: "existing", id });
              turn.navigate("select", false);
              setChatPath(id);
              setListOpen(false);
            },
          }}
        />
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
            <ConversationHead
              headerText={headerText}
              badge={badge}
              listOpen={listOpen}
              onToggleList={() => setListOpen((value) => !value)}
              playbook={Boolean(playbook)}
              contextToggle={contextDock.contextToggle}
              contextOpen={chatWorkspace.open}
              setContextOpen={chatWorkspace.setOpen}
              hasConversation={Boolean(current)}
              menuItems={menuItems}
            />
          </ReadingColumn>
          {run?.taskRunId && activeId && !conversationFailed ? (
            <TaskRunLine
              key={run.taskRunId}
              marker={run}
              conversationId={activeId}
              playbook={storedPlaybook}
              permissions={session.permissions}
              refreshedAt={detail.dataUpdatedAt}
            />
          ) : null}
          {summaryLine ? (
            <ReadingColumn className="pt-2">
              <p className="truncate text-xs text-muted-foreground" data-testid="chat-summary">
                {summaryLine}
              </p>
            </ReadingColumn>
          ) : null}
          <TurnErrors
            turn={turn}
            busy={busy}
            questionOpen={Boolean(pendingDecision || pendingChoice || pendingForm)}
          />
          <ChatTranscript
            turn={turn}
            questions={questions}
            lookups={lookups}
            activeId={activeId}
            messages={messages}
            conversationFailed={conversationFailed}
            conversationMissing={conversationMissing}
            onRetryLoad={() => void detail.refetch()}
            startEmpty={selection.kind === "new" && Boolean(initialPrompt)}
            fillComposer={fillComposer}
            showOptimistic={showOptimistic}
            busy={busy}
            decisionErrorFor={decisionErrorFor}
            openStoredFile={openStoredFile}
            playbookPlacement={playbookPlacement}
            playbookSummary={playbookSummary}
            dock={
              <QuestionDock
                turn={turn}
                activeId={activeId}
                busy={busy}
                status={status}
                decisionErrorFor={decisionErrorFor}
                unanchoredDecision={lookups.unanchored(pendingDecision)}
                unanchoredChoice={lookups.unanchored(pendingChoice)}
                unanchoredForm={lookups.unanchored(pendingForm)}
                showPreparation={showPreparation}
                showDraftConflict={showDraftConflict}
                liveTest={liveTest}
                showScheduleStep={showScheduleStep}
                heldTarget={heldTarget}
                targetWorkflowId={targetWorkflowId}
                showProdLiveTest={showProdLiveTest}
                unsaved={resume?.unsaved}
                readyAutomations={readyAutomations}
                readySchedules={readySchedules}
              />
            }
          />

          <ChatComposerArea
            turn={turn}
            activeId={activeId}
            conversationFailed={conversationFailed}
            busy={busy}
            status={status}
            pillMode={pillMode}
            pillLabel={run ? null : pillLabel}
            runScope={run ? t("chat.taskRun.scope") : null}
            setNewPermissionMode={setNewPermissionMode}
            composerHint={composerHint}
            initialInput={selection.kind === "new" ? initialPrompt : ""}
            choiceOpen={choiceOpen}
            formOpen={formOpen}
            pendingText={pendingText}
            attachments={attachments}
            setAttachments={setAttachments}
            setPreview={setPreview}
            restoreComposer={restoreComposer}
            usage={activeId ? detail.data?.usage : null}
            budget={budget}
          />
        </div>
        {chatWorkspace.docked && chatWorkspace.open ? (
          <ChatContextDock
            dock={contextDock}
            width={chatWorkspace.dockWidth}
            playbook={Boolean(playbook)}
          />
        ) : null}
      </div>

      <AttachmentPreviewSheet preview={preview} onClose={() => setPreview(null)} />

      <ChatContextSheet
        dock={contextDock}
        open={!chatWorkspace.docked && chatWorkspace.open}
        onOpenChange={chatWorkspace.setOpen}
        playbook={Boolean(playbook)}
      />
      {current || chatWorkspace.open
        ? createPortal(
            <ChatContextContent
              playbook={playbook}
              playbookActionTargetFor={playbookActionTargetFor}
              openPlaybookQuestion={openPlaybookQuestion}
              refreshFailed={detail.isRefetchError}
              current={current}
              origin={origin}
              anyQuestion={anyQuestion}
              decidePending={decidePending}
              resume={resume}
              nextAction={nextAction}
              heldTarget={heldTarget}
              targetWorkflowId={targetWorkflowId}
              showScheduleStep={showScheduleStep}
              activeId={activeId}
              status={status}
              setContextOpen={chatWorkspace.setOpen}
              submitTurn={submitTurn}
              referencedResources={referencedResources}
              createdResources={createdResources}
            />,
            contextDock.contextContainer,
          )
        : null}

      <ConversationDialogs dialogs={dialogs} />
    </Page>
  );
}
