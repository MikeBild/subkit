import {
  ElicitRouter,
  ExitFlow,
  HistorySearch,
  ScrollView,
  ThemeProvider,
  terminalSize,
} from "@chat-ui/index.ts";
import type { SkSessionState, TurnEvent } from "@cli-core/index.ts";
import { initialSessionState } from "@cli-core/index.ts";
import { Box, Static, Text, useApp, useStdout } from "ink";
import type React from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { readExtendedTurnUsage } from "./engine-client.ts";
import { runBuiltinSlash } from "./ink-app/builtin-slash.ts";
import { Composer, DEFAULT_RULE_WIDTH, SuggestionList } from "./ink-app/composer.tsx";
import { useComposerKeys } from "./ink-app/composer-keys.ts";
import {
  useGhostFeedback,
  usePasteBuffers,
  usePromptHistory,
  useSecretRedirect,
} from "./ink-app/composer-state.ts";
import { renderElicitAnswer } from "./ink-app/elicit-transcript.ts";
import { PaneHost } from "./ink-app/panes.tsx";
import {
  dispatchSlashSubmit,
  drainQueueOrHold,
  preparePromptForEngine,
  runEventStream,
  showPendingElicitationHint,
  warnIfUnresolvedConfirmIntent,
} from "./ink-app/submit-pipeline.ts";
import { buildTranscript } from "./ink-app/transcript.tsx";
import {
  extractNextBestActions,
  renderTurnSpinner,
  renderValidationErrorsBlock,
  StatusBar,
} from "./ink-app/transcript-cells.tsx";
import type { InkAppProps, TranscriptMode } from "./ink-app/types.ts";
import { useNotices, usePendingElicitationNotice } from "./ink-app/use-notices.ts";
import { useOAuthAutoResume } from "./ink-app/use-oauth-auto-resume.ts";
import { useStatusLine } from "./ink-app/use-status-line.ts";
import { WelcomeRow } from "./ink-app/welcome-row.tsx";
import { ActivityLine } from "./repl/activity-line.tsx";
import { AlternateScreen } from "./repl/alt-screen.tsx";
import { Footer } from "./repl/footer.tsx";
import { InlineHistorySearch } from "./repl/inline-history-search.tsx";
import {
  apply as applyInput,
  buffer,
  EMPTY_BUFFER,
  type InputBuffer,
} from "./repl/input-buffer.ts";
import {
  applyMention,
  extractMention,
  type MentionCandidate,
  MentionPicker,
} from "./repl/mention-picker.tsx";
import { PendingPasteRefs } from "./repl/pending-attachments.tsx";
import { createQueue } from "./repl/queue.ts";
import type { PaneSpec } from "./repl/slash/handler.ts";
import { SlashSuggest } from "./repl/slash/SlashSuggest.tsx";
import { buildStarterTaskActions } from "./repl/starter-action-injection.ts";
import { type TaskAction, taskActionsForContext } from "./repl/task-actions.ts";
import { TaskLauncher } from "./repl/task-launcher.tsx";
import { pickTip } from "./repl/welcome-banner.tsx";
import { NoticeStack } from "./shell/NoticeStack.tsx";
import { ResizeBoundary } from "./shell/ResizeBoundary.tsx";
import { ToastQueue } from "./shell/ToastQueue.tsx";
import { TranscriptPager } from "./shell/TranscriptPager.tsx";
import { searchSlashCommands } from "./slash.ts";

export { renderElicitAnswer } from "./ink-app/elicit-transcript.ts";
export { extractNextBestActions } from "./ink-app/transcript-cells.tsx";
export type { InkAppProps } from "./ink-app/types.ts";

export const InkApp: React.FC<InkAppProps> = ({
  persona,
  statusLineConfig,
  initialConversationId,
  initialSession,
  sessionVersion = 0,
  profileNotice,
  model,
  cwd,
  statusSnapshot,
  setupSnapshot,
  connectionSnapshot,
  digestSnapshot,
  pendingIntake = null,
  historyPath,
  onPrompt,
  initialContextStatus,
  onSlash,
  onSelectConversation,
  onNewSession,
  onElicitResponse,
  onExit,
  onCancelConversation,
  resumeSummary,
  engineClient,
  engineMentionCandidates = [],
  prefs,
  pushNotifyOverride,
  nextCommandPreviewEnabled = true,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = terminalSize(stdout).columns ?? DEFAULT_RULE_WIDTH;
  const rows = terminalSize(stdout).rows ?? 30;
  const [session, setSession] = useState<SkSessionState>(
    () => initialSession ?? initialSessionState(initialConversationId ?? null),
  );
  useEffect(() => {
    setSession(initialSession ?? initialSessionState(initialConversationId ?? null));
  }, [initialConversationId, initialSession, sessionVersion]);
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);

  const [input, setInput] = useState<InputBuffer>(EMPTY_BUFFER);
  const [busy, setBusy] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const busyRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  const [pagerOpen, setPagerOpen] = useState(false);
  const [pane, setPane] = useState<PaneSpec | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const latestChipsRef = useRef<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inlineSearchOpen, setInlineSearchOpen] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("chat");
  const tip = useRef<string>(pickTip());

  const { notices, setNotices, dismissNotice, showInfo, showError, showStructuredError } =
    useNotices();
  const shownProfileNotice = useRef<number | null>(null);
  useEffect(() => {
    if (!profileNotice || shownProfileNotice.current === profileNotice.version) return;
    shownProfileNotice.current = profileNotice.version;
    showInfo(profileNotice.message);
  }, [profileNotice, showInfo]);

  const starterTaskActions = useMemo(
    () => buildStarterTaskActions(persona.label, persona.probe, digestSnapshot, pendingIntake),
    [persona.label, persona.probe, digestSnapshot, pendingIntake],
  );
  const availableTaskActions = useMemo(
    () =>
      taskActionsForContext(
        persona.probe,
        resumeSummary === undefined ? undefined : { resumeSummary },
      ),
    [persona.probe, resumeSummary],
  );

  const { historyRef, historyCursorRef, historyDraftRef, effectiveHistoryPath, recordPrompt } =
    usePromptHistory(historyPath, persona.tenant);

  const { pasteStoreRef, pendingPasteRefs, syncPendingPasteRefs, insertPasteChunk } =
    usePasteBuffers(setInput, showInfo);
  const queueRef = useRef(createQueue());
  const pendingElicitationRef = useRef(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const transientStatusRef = useRef<string | null>(null);
  const setTransientStatus = useCallback((msg: string | null) => {
    transientStatusRef.current = msg;
  }, []);
  useEffect(() => {
    if (!initialContextStatus) return;
    showInfo(initialContextStatus);
    setTransientStatus(initialContextStatus);
    const timer = setTimeout(() => setTransientStatus(null), 5000);
    return () => clearTimeout(timer);
  }, [initialContextStatus, setTransientStatus, showInfo]);
  const recentListsRef = useRef<Map<string, unknown[]>>(new Map());

  const {
    pendingSecretRedirect,
    consumeArmedRedirect,
    interceptPlainPrompt,
    cancelSecretRedirect,
  } = useSecretRedirect(pasteStoreRef, syncPendingPasteRefs, setInput, showInfo);

  const { ghostHandledRef } = useGhostFeedback(input, session.conversationId, engineClient);

  usePendingElicitationNotice(session.pendingElicitation, pendingElicitationRef, setNotices);

  useOAuthAutoResume(session.pendingElicitation, engineClient, submitElicitationResponse);

  useEffect(() => {
    let next: string[] = [];
    for (const call of session.toolCalls) {
      const chips = extractNextBestActions(call.result);
      if (chips.length > 0) next = chips;
    }
    latestChipsRef.current = next;
  }, [session.toolCalls]);

  const statusLine = useStatusLine({
    statusLineConfig,
    persona,
    model,
    cwd,
    session,
    statusSnapshot,
    connectionSnapshot,
    resumeSummary,
    transientStatusRef,
  });

  const handleBuiltinSlash = useCallback(
    async (trimmed: string): Promise<boolean> =>
      runBuiltinSlash(trimmed, {
        engineClient,
        cwd,
        conversationId: session.conversationId,
        historyPath: effectiveHistoryPath,
        transcriptMode,
        pasteStoreRef,
        queue: queueRef.current,
        recentLists: recentListsRef.current,
        historyRef,
        historyCursorRef,
        insertText: (text) => setInput((prev) => applyInput(prev, { type: "insert", text })),
        setPane,
        setTranscriptMode,
        openLauncher: () => setLauncherOpen(true),
        syncPendingPasteRefs,
        setTransientStatus,
        showInfo,
        showError,
      }),
    [
      cwd,
      effectiveHistoryPath,
      showError,
      showInfo,
      syncPendingPasteRefs,
      transcriptMode,
      engineClient,
      session.conversationId,
      setTransientStatus,
      pasteStoreRef,
      historyRef,
      historyCursorRef,
    ],
  );

  const resetSession = useCallback(() => {
    setSession(initialSessionState(null));
    onNewSession?.();
  }, [onNewSession]);

  const applyEventStream = useCallback(
    async (
      base: SkSessionState,
      events: AsyncIterable<TurnEvent> | undefined,
      conversationId?: string | null,
    ): Promise<SkSessionState> =>
      runEventStream({
        base,
        events,
        conversationId,
        setSession,
        setInput,
        nextCommandPreviewEnabled,
        prefs,
        pushNotifyOverride,
      }),
    [nextCommandPreviewEnabled],
  );

  async function submitElicitationResponse(
    elicitationId: string,
    output: unknown,
    reason?: string,
  ): Promise<void> {
    if (!onElicitResponse) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let reopenedElicitation = false;
    try {
      const answerText = renderElicitAnswer(output, session.pendingElicitation?.input, reason);
      const lastMsg = session.messages[session.messages.length - 1];
      const alreadyEchoed =
        lastMsg?.role === "user" &&
        lastMsg.id === undefined &&
        lastMsg.content.trim() === answerText.trim();
      const withAnswer: SkSessionState = alreadyEchoed
        ? {
            ...session,
            pendingElicitation: null,
            status: "running",
          }
        : {
            ...session,
            messages: [...session.messages, { role: "user", content: answerText }],
            pendingElicitation: null,
            status: "running",
          };
      setSession(withAnswer);
      const outcome = await onElicitResponse(elicitationId, output, reason);
      const finalState = await applyEventStream(
        withAnswer,
        outcome?.events,
        outcome?.conversationId ?? session.conversationId,
      );
      reopenedElicitation = finalState.pendingElicitation !== null;
    } catch (err) {
      showStructuredError(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
      drainQueueOrHold({
        openedElicitation: reopenedElicitation,
        pendingElicitationRef,
        queue: queueRef.current,
        setQueuedCount,
        showInfo,
        resubmit: (raw) => {
          void handleSubmit(raw);
        },
      });
    }
  }

  const handleSubmit = useCallback(
    async (raw: string): Promise<void> => {
      const redirected = consumeArmedRedirect();
      if (redirected !== null) raw = redirected.message;
      const redirectEvent = redirected?.event;
      const trimmed = raw.trim();
      setInput(EMPTY_BUFFER);
      historyDraftRef.current = null;
      if (!trimmed) return;
      if (!trimmed.startsWith("/")) {
        if (interceptPlainPrompt(trimmed)) return;
      }
      if (
        await dispatchSlashSubmit(trimmed, {
          session,
          busyRef,
          personaProbe: persona.probe,
          personaLabel: persona.label,
          exit,
          onExit,
          onSlash,
          hasElicitHandler: Boolean(onElicitResponse),
          setPane,
          showInfo,
          showError,
          showStructuredError,
          respondElicitation: submitElicitationResponse,
          runBuiltin: handleBuiltinSlash,
        })
      ) {
        return;
      }

      if (session.pendingElicitation) {
        showPendingElicitationHint(session.pendingElicitation, trimmed, busyRef.current, showInfo);
        return;
      }

      warnIfUnresolvedConfirmIntent(session, trimmed, showError);
      if (busyRef.current) {
        queueRef.current.enqueue(trimmed);
        setQueuedCount(queueRef.current.length);
        showInfo(`queued (${queueRef.current.length}) — runs after the current turn`);
        return;
      }
      busyRef.current = true;
      setBusy(true);

      const prepared = await preparePromptForEngine({
        trimmed,
        pasteStore: pasteStoreRef.current,
        engineClient,
        cwd,
        conversationId: session.conversationId,
        showInfo,
        showError,
      });
      if (!prepared) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      const { finalPrompt, consumedIds } = prepared;

      recordPrompt(trimmed);
      let turnOpenedElicitation = false;
      try {
        setNotices((current) => current.filter((item) => item.tone !== "error"));
        const lastMsg = session.messages[session.messages.length - 1];
        const alreadyEchoed =
          lastMsg?.role === "user" &&
          lastMsg.id === undefined &&
          lastMsg.content.trim() === trimmed.trim();
        const optimisticSession: SkSessionState = alreadyEchoed
          ? session
          : {
              ...session,
              messages: [...session.messages, { role: "user", content: trimmed }],
            };
        if (!alreadyEchoed) setSession(optimisticSession);
        const { events, conversationId, contextStatus } = await onPrompt(finalPrompt, {
          raw_prompt: trimmed,
          ...(redirectEvent ? { event: redirectEvent } : {}),
        });
        if (contextStatus) {
          showInfo(contextStatus);
          setTransientStatus(contextStatus);
          setTimeout(() => setTransientStatus(null), 5000);
        }
        const finalState = await applyEventStream(
          { ...optimisticSession, conversationId },
          events,
          conversationId,
        );
        for (const id of consumedIds) pasteStoreRef.current.delete(id);
        syncPendingPasteRefs();
        turnOpenedElicitation = finalState.pendingElicitation !== null;
      } catch (err) {
        showStructuredError(err);
      } finally {
        busyRef.current = false;
        setBusy(false);
        drainQueueOrHold({
          openedElicitation: turnOpenedElicitation,
          pendingElicitationRef,
          queue: queueRef.current,
          setQueuedCount,
          showInfo,
          resubmit: (nextQueued) => {
            void handleSubmit(nextQueued);
          },
        });
      }
    },
    [
      cwd,
      engineClient,
      exit,
      onElicitResponse,
      onExit,
      onPrompt,
      onSlash,
      pendingSecretRedirect,
      persona.probe,
      persona.label,
      session,
      applyEventStream,
      handleBuiltinSlash,
      consumeArmedRedirect,
      interceptPlainPrompt,
      recordPrompt,
      setNotices,
      showError,
      showInfo,
      showStructuredError,
      submitElicitationResponse,
      syncPendingPasteRefs,
    ],
  );

  const invokeTaskAction = useCallback(
    (action: TaskAction, mode: "prefill" | "submit" = "submit"): void => {
      if (action.invoke.kind === "builtin") {
        if (action.invoke.name === "launcher") setLauncherOpen(true);
        return;
      }
      if (action.invoke.kind === "slash") {
        void handleSubmit(action.invoke.command);
        return;
      }
      if (mode === "prefill") {
        setInput(buffer(action.invoke.prompt));
        return;
      }
      void handleSubmit(action.invoke.prompt);
    },
    [handleSubmit],
  );

  const elicitOpen = session.pendingElicitation !== null;
  const composerActive =
    pane === null && !launcherOpen && !historyOpen && !inlineSearchOpen && !elicitOpen;
  const slashMode = input.value.startsWith("/");
  const slashNavigable = slashMode && !/\s/.test(input.value);
  const slashMatches = useMemo(
    () => (slashNavigable ? searchSlashCommands(input.value, persona.probe, 5) : []),
    [slashNavigable, input.value, persona.probe],
  );
  useEffect(() => {
    if (slashMatches.length === 0) {
      if (slashSelectedIndex !== 0) setSlashSelectedIndex(0);
      return;
    }
    if (slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1);
    }
  }, [slashMatches.length, slashSelectedIndex]);
  const mentionSpec = useMemo(
    () => (composerActive ? extractMention(input.value, input.cursor) : null),
    [composerActive, input.value, input.cursor],
  );
  const showWelcomeActions =
    session.messages.length === 0 && input.value.length === 0 && pane === null && !launcherOpen;

  useComposerKeys({
    input,
    setInput,
    insertPasteChunk,
    composerActive,
    conversationId: session.conversationId,
    engineClient,
    pendingElicitation: session.pendingElicitation,
    busyRef,
    onCancelConversation,
    ghostHandledRef,
    slashNavigable,
    slashMatches,
    slashSelectedIndex,
    setSlashSelectedIndex,
    historyRef,
    historyCursorRef,
    historyDraftRef,
    pane,
    setPane,
    notices,
    dismissNotice,
    inlineSearchOpen,
    setInlineSearchOpen,
    setPagerOpen,
    setAltScreen,
    setTranscriptMode,
    secretRedirectArmed: pendingSecretRedirect !== null,
    cancelSecretRedirect,
    latestChipsRef,
    invokeTaskAction,
    handleSubmit,
    showWelcomeActions,
    starterTaskActions,
    mentionSpec,
    showInfo,
  });

  const welcomeRow = (
    <WelcomeRow
      key="welcome"
      persona={persona}
      conversationId={session.conversationId}
      transcriptMode={transcriptMode}
      connectionSnapshot={connectionSnapshot}
      resumeSummary={resumeSummary}
      statusSnapshot={statusSnapshot}
      setupSnapshot={setupSnapshot}
      digestSnapshot={digestSnapshot}
      pendingIntake={pendingIntake}
      tip={tip.current}
    />
  );

  const activeUnanchoredElicitation =
    session.pendingElicitation && !session.pendingElicitation.parent_message_id
      ? session.pendingElicitation
      : null;
  const { staticRows, dynamicRows, pagerEntries, elicitFallback } = buildTranscript({
    session: activeUnanchoredElicitation ? { ...session, pendingElicitation: null } : session,
    messages: deferredMessages,
    toolCalls: deferredToolCalls,
    columns,
    transcriptMode,
    busy,
    busyRef,
    elicitInputDisabled: pane !== null || launcherOpen || slashMode,
    welcomeRow,
    onSubmit: (raw) => {
      void handleSubmit(raw);
    },
    onRespondElicitation: (elicitationId, output, reason) => {
      void submitElicitationResponse(elicitationId, output, reason);
    },
  });

  const content = (
    <Box flexDirection="column">
      <NoticeStack items={notices} />

      {activeUnanchoredElicitation ? (
        <ElicitRouter
          elicitation={activeUnanchoredElicitation}
          inputDisabled={pane !== null || launcherOpen || slashMode}
          onResponse={(output) => {
            const reason =
              "decision_reason" in output && typeof output.decision_reason === "string"
                ? output.decision_reason
                : undefined;
            submitElicitationResponse(activeUnanchoredElicitation.id, output, reason);
          }}
        />
      ) : null}

      {!activeUnanchoredElicitation && staticRows.length > 0 ? (
        <Static key={`session-${sessionVersion}`} items={staticRows}>
          {(row) => row}
        </Static>
      ) : null}
      {!activeUnanchoredElicitation && dynamicRows.length > 0 ? (
        <ScrollView active={composerActive && pane === null}>{dynamicRows}</ScrollView>
      ) : null}

      {elicitFallback}

      <PaneHost
        pane={pane}
        engineClient={engineClient}
        conversationId={session.conversationId}
        messages={session.messages}
        turnTokens={session.usage?.turn_tokens ?? null}
        statusTenantId={statusSnapshot?.tenant.id}
        launcherOpen={launcherOpen}
        onDismiss={() => setPane(null)}
        showInfo={showInfo}
        showError={showError}
        onSelectConversation={onSelectConversation}
        onNewSession={resetSession}
        onSignOut={() => {
          if (onExit) onExit();
          else exit();
        }}
        launcherSlot={
          launcherOpen ? (
            <TaskLauncher
              actions={availableTaskActions}
              onSelect={(action) => {
                setLauncherOpen(false);
                invokeTaskAction(action, "submit");
              }}
              onDismiss={() => setLauncherOpen(false)}
              inputDisabled={pane !== null}
            />
          ) : null
        }
      />
      {historyOpen ? (
        <HistorySearch
          entries={historyRef.current}
          onSelect={(prompt) => {
            setHistoryOpen(false);
            setInput(buffer(prompt));
            historyCursorRef.current = historyRef.current.length;
          }}
          onDismiss={() => setHistoryOpen(false)}
        />
      ) : null}
      {inlineSearchOpen ? (
        <InlineHistorySearch
          entries={historyRef.current}
          onCommit={(prompt) => {
            setInlineSearchOpen(false);
            setInput(buffer(prompt));
            historyCursorRef.current = historyRef.current.length;
          }}
          onCancel={() => setInlineSearchOpen(false)}
        />
      ) : null}

      {renderValidationErrorsBlock(session.validationErrors, session.status)}
      {renderTurnSpinner(session.toolCalls, busy, session.usage?.turn_tokens ?? null)}

      <ActivityLine activity={session.activity} active={busy} />

      <TranscriptPager
        open={pagerOpen}
        entries={pagerEntries}
        onClose={() => setPagerOpen(false)}
        rows={rows}
      />

      <StatusBar statusLine={statusLine} columns={columns} />

      <PendingPasteRefs items={pendingPasteRefs} />

      <Composer input={input} busy={busy} />

      <Footer
        user={statusSnapshot?.user.email ?? statusSnapshot?.user.id ?? persona.label}
        tenant={statusSnapshot?.tenant.slug ?? statusSnapshot?.tenant.id ?? persona.tenant}
        engineUrl={persona.engineUrl}
        sessionId={session.conversationId}
        transcriptMode={transcriptMode}
        connectionState={connectionSnapshot?.state ?? "unknown"}
        connectionReason={connectionSnapshot?.reason ?? null}
        sessionTokens={session.sessionTotalTokens}
        tokensToday={statusSnapshot?.tokens_today ?? null}
        tokensMonth={statusSnapshot?.tokens_month ?? null}
        promptTokensLastCall={readExtendedTurnUsage(session.usage).prompt_tokens_last_call}
        turnTokensTotal={
          readExtendedTurnUsage(session.usage).turn_tokens_total ??
          session.usage?.turn_tokens ??
          null
        }
        contextCapTokens={session.usage?.context_cap_tokens ?? null}
        cacheReadTokens={readExtendedTurnUsage(session.usage).cache_read_tokens}
        cacheReadPct={readExtendedTurnUsage(session.usage).cache_read_pct}
        columns={columns}
      />

      {mentionSpec && pane === null && !inlineSearchOpen ? (
        <MentionPicker
          query={mentionSpec.query}
          cwd={cwd ?? process.cwd()}
          engineCandidates={engineMentionCandidates}
          onPick={(candidate: MentionCandidate) => {
            setInput((prev) => {
              const next = applyMention(prev.value, prev.cursor, mentionSpec.start, candidate);
              return { value: next.value, cursor: next.cursor };
            });
          }}
          onDismiss={() => {}}
        />
      ) : null}

      {queuedCount > 0 ? (
        <Box>
          <Text color="yellow">⏸ </Text>
          <Text dimColor>{queuedCount} queued — drains when turn completes</Text>
        </Box>
      ) : null}

      {pane === null && !launcherOpen && !mentionSpec ? (
        <>
          {input.value.length === 0 ? (
            <SlashSuggest buffer="" cursor={0} persona={persona.probe} showWelcomeHint={true} />
          ) : null}
          <SuggestionList
            query={input.value}
            probe={persona.probe}
            selectedIndex={slashSelectedIndex}
          />
        </>
      ) : null}

      <ExitFlow
        onExit={() => {
          exit();
          onExit?.();
        }}
      />
    </Box>
  );

  return (
    <ThemeProvider>
      <ResizeBoundary>
        <ToastQueue>
          <AlternateScreen enabled={altScreen}>{content}</AlternateScreen>
        </ToastQueue>
      </ResizeBoundary>
    </ThemeProvider>
  );
};
