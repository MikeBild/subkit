// Ink-based rich REPL root for `sk`.
//
// Wires together every UX surface of the conversational REPL:
//
//   * <WelcomeBanner> on first paint (unicode-block logo + tip)
//   * Scriptable status line with rate-limited rebuild ticker
//   * Animated thinking spinner (rotating verbs + elapsed + tokens)
//   * Blinking `●` tool-call dot
//   * Prefix-based slash-command autocomplete footer
//   * Ctrl-T alternate-screen transcript toggle
//   * useDeferredValue on the message list so long histories stay
//     responsive when typing
//   * Kind-specific approval router for save_workflow_draft / external_write
//
// The component is a pure consumer of the engine stream — all
// state transitions go through `applyTurnEvent` from @cli-core.
//
// The heavy lifting lives in sibling modules under `./ink-app/`:
// transcript assembly, cell components, modal panes, the key-input
// hook, the submit pipeline, and the composer-adjacent state hooks.
// This file is the orchestrator that owns session state and wires
// those modules together.

import { ExitFlow, HistorySearch, ScrollView, ThemeProvider } from "@chat-ui/index.ts";
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
import { useYoloMode } from "./ink-app/use-yolo.ts";
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
import { loadWhatsNew, loadWhatsNewSync } from "./repl/welcome-banner/whats-new.ts";
import { pickTip } from "./repl/welcome-banner.tsx";
import { NoticeStack } from "./shell/NoticeStack.tsx";
import { ResizeBoundary } from "./shell/ResizeBoundary.tsx";
import { ToastQueue } from "./shell/ToastQueue.tsx";
import { TranscriptPager } from "./shell/TranscriptPager.tsx";
import { searchSlashCommands } from "./slash.ts";

export { renderElicitAnswer } from "./ink-app/elicit-transcript.ts";
export { extractNextBestActions } from "./ink-app/transcript-cells.tsx";
// Public surface — the prop contract lives in ./ink-app/types.ts, the
// two helpers below in their domain modules; all three stay importable
// from this module so external consumers (tests, hosts) are unchanged.
export type { InkAppProps } from "./ink-app/types.ts";

// ---------- Top-level App ----------

export const InkApp: React.FC<InkAppProps> = ({
  persona,
  statusLineConfig,
  initialConversationId,
  model,
  cwd,
  statusSnapshot,
  setupSnapshot,
  connectionSnapshot,
  digestSnapshot,
  permissionMode = "ask",
  historyPath,
  onPrompt,
  onSlash,
  onSelectConversation,
  onElicitResponse,
  onExit,
  onCancelConversation,
  resumeSummary,
  engineClient,
  prefs,
  pushNotifyOverride,
  nextCommandPreviewEnabled = true,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const rows = stdout?.rows ?? 30;
  const [session, setSession] = useState<SkSessionState>(() =>
    initialSessionState(initialConversationId ?? null),
  );
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);

  const [input, setInput] = useState<InputBuffer>(EMPTY_BUFFER);
  const [busy, setBusy] = useState(false);
  // Slash-suggestion selection. Only meaningful when the buffer starts
  // with `/` and has no whitespace yet; ↑/↓ cycle the highlighted match,
  // Tab completes it, Enter on an empty-arg slash submits the selected
  // command. Reset on every buffer mutation so the index never points
  // past the live match list.
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  // Synchronous guard against Enter auto-repeat. `setBusy(true)` is
  // async, so without this ref two Enter presses ~1ms apart both see
  // `busy === false` and each spawn a turn, posting the same prompt
  // twice (or 50 times if the key is held down).
  const busyRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  // Transcript pager — Ctrl-P toggles a modal overlay that renders
  // every cell with full output and unabridged diffs.
  const [pagerOpen, setPagerOpen] = useState(false);
  const [pane, setPane] = useState<PaneSpec | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  // Latest `next_best_actions` list rendered to the operator. The
  // digit-key handler reads this when the composer is empty so 1..9
  // dispatches `please run <action>` for the corresponding chip.
  // Updated post-render via a useEffect that mirrors the latest
  // chips computed while walking tool calls.
  const latestChipsRef = useRef<string[]>([]);
  // Inline Ctrl-R history search (above-composer widget). The old
  // modal `<HistorySearch>` pane is still available via `historyOpen`
  // as a fallback for constrained terminals.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inlineSearchOpen, setInlineSearchOpen] = useState(false);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("chat");
  const tip = useRef<string>(pickTip());
  // Initial value: read cache + bundled CHANGELOG synchronously so the
  // banner gets a real headline on first paint. The async `loadWhatsNew`
  // below still runs to refresh the cache for the next session.
  // The banner sits in Ink's <Static> block which flushes once, so an
  // async-only update would never reach the rendered banner.
  const [whatsNew, setWhatsNew] = useState<string | null>(() => loadWhatsNewSync());
  useEffect(() => {
    let cancelled = false;
    loadWhatsNew()
      .then((headline) => {
        if (!cancelled) setWhatsNew(headline);
      })
      .catch(() => {
        // loadWhatsNew never throws by contract; ignore defensively.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { notices, setNotices, dismissNotice, showInfo, showError, showStructuredError } =
    useNotices();

  // Permission mode + the yolo arming/expiry state machine.
  const { activeMode, setActiveMode, noteTurnStart, consumeArmAnswer, runYoloSlash } = useYoloMode(
    permissionMode,
    showInfo,
    showError,
  );

  // Render + dispatch lists derive injection (and the RBAC gate) from the same
  // (probe, digest) inputs inside the shared helpers, so they can't drift.
  const starterTaskActions = useMemo(
    () => buildStarterTaskActions(persona.label, persona.probe, digestSnapshot),
    [persona.label, persona.probe, digestSnapshot],
  );
  const availableTaskActions = useMemo(
    () =>
      taskActionsForContext(
        persona.probe,
        resumeSummary === undefined ? undefined : { resumeSummary },
      ),
    [persona.probe, resumeSummary],
  );

  // -------- Persistent prompt history --------
  const { historyRef, historyCursorRef, historyDraftRef, effectiveHistoryPath, recordPrompt } =
    usePromptHistory(historyPath, persona.tenant);

  // -------- Paste store + busy-turn command queue --------
  const { pasteStoreRef, pendingPasteRefs, syncPendingPasteRefs, insertPasteChunk } =
    usePasteBuffers(setInput, showInfo);
  const queueRef = useRef(createQueue());
  // Live mirror of `session.pendingElicitation`. The post-turn queue
  // drain runs from a `handleSubmit` closure captured at turn-start, so
  // its `session` is stale — it cannot see an elicitation that arrived
  // during the turn. The drain consults this ref instead, so a queued
  // prompt is never flushed past a freshly-opened dialog.
  const pendingElicitationRef = useRef(false);
  const [queuedCount, setQueuedCount] = useState(0);
  // Transient status-line message channel. Upload progress writes
  // here on every chunk; the next status-line tick (≤500 ms) folds
  // it into `status_message`. The string is cleared synchronously
  // when the upload completes or fails. Held as a ref — the
  // status-line tick reads from `current` each interval, so we
  // don't need a state update per chunk.
  const transientStatusRef = useRef<string | null>(null);
  const setTransientStatus = useCallback((msg: string | null) => {
    transientStatusRef.current = msg;
  }, []);
  // Cache of the most recent numbered listings rendered into a text
  // pane (today: `/files`). The slash dispatch keeps a tiny
  // Map<cacheKey, rows[]> so `/files <n>` can resolve the n-th row
  // without re-listing.
  const recentListsRef = useRef<Map<string, unknown[]>>(new Map());

  // Input-side credential filter (PR5) — see composer-state.ts.
  const {
    pendingSecretRedirect,
    consumeArmedRedirect,
    interceptPlainPrompt,
    cancelSecretRedirect,
  } = useSecretRedirect(pasteStoreRef, syncPendingPasteRefs, setInput, showInfo);

  // Ghost-text accept / typed-over feedback tracking.
  const { ghostHandledRef } = useGhostFeedback(input, session.conversationId, engineClient);

  // "Waiting for input" notice + drain-side pending-elicitation mirror.
  usePendingElicitationNotice(session.pendingElicitation, pendingElicitationRef, setNotices);

  // OAuth auto-resume — resolves the `authenticate_oauth` review
  // elicitation the moment the engine reports a successful callback.
  useOAuthAutoResume(session.pendingElicitation, engineClient, submitElicitationResponse);

  // Sync the latest-chips ref whenever the tool-call list changes. The
  // ref drives the digit-key shortcut in the key handler — pressing
  // 1..9 with an empty composer dispatches `please run <action>` for
  // the matching chip. We walk the calls in chronological order and
  // pick the last one whose `next_best_actions` list is non-empty.
  // Watching `session.toolCalls` (not the deferred copy) keeps the
  // shortcut responsive on the very next render frame after a tool
  // result lands — useDeferredValue can lag a paint or two on slow
  // hosts and the operator should not have to wait for that.
  useEffect(() => {
    let next: string[] = [];
    for (const call of session.toolCalls) {
      const chips = extractNextBestActions(call.result);
      if (chips.length > 0) next = chips;
    }
    latestChipsRef.current = next;
  }, [session.toolCalls]);

  // -------- Status line ticker --------
  const statusLine = useStatusLine({
    statusLineConfig,
    persona,
    model,
    cwd,
    session,
    statusSnapshot,
    connectionSnapshot,
    activeMode,
    resumeSummary,
    transientStatusRef,
  });

  // -------- Slash command handlers that live inside ink-app --------
  //
  // `/paste`, `/knowledge`, `/queue`, `/files`, `/history`, `/view`,
  // `/actions` — see ./ink-app/builtin-slash.ts. Other slash commands
  // fall through to the host's `onSlash`.
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
    // Choke-point idempotency: every caller (slash command, bare-text
    // shortcut, ElicitRouter digit-shortcut) routes through this. If the
    // engine is already processing a previous response, drop the
    // duplicate. Without this, two fast keystrokes POST /respond twice,
    // the engine re-resolves an already-resolved elicitation, and a
    // second runLoop fires — the silent-hang transcript's failure mode.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // True when resolving this dialog opened another — the `finally`
    // drain consults it so a queued prompt never races the next dialog.
    let reopenedElicitation = false;
    try {
      // Synthesize a user-role message capturing what the operator
      // just chose so the transcript doesn't look like the LLM
      // produced the answer out of thin air. Without this, an
      // approve-then-next-turn flow shows the LLM saying "Approve"
      // with no visible source. See bug E in the fix plan.
      // Pass the elicitation's `input` so renderElicitAnswer can
      // redact sensitive form fields based on the schema instead of
      // collapsing every form to `(answered)`.
      const answerText = renderElicitAnswer(output, session.pendingElicitation?.input, reason);
      // De-dupe at the insert site — mirrors handleSubmit's
      // `alreadyEchoed` guard. Two consecutive elicit responses that
      // render to the same redacted text (e.g. two form prompts that
      // both ask for `token`, the assistant re-asks because the first
      // submission failed validation, or any path where the prior
      // optimistic echo is still the last message) would otherwise
      // produce two `› you token=***` lines in the transcript with
      // nothing between them. Engine never replays elicit answers as
      // role=user message events (service.ts:605 `user_message:null`
      // when resuming), so the turn-event dedupe at turn-event.ts:426
      // never gets a chance to collapse the duplicates.
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
      // Resolving one dialog can open the next — don't drain past it.
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

  // -------- Submit orchestration --------
  const handleSubmit = useCallback(
    async (raw: string): Promise<void> => {
      // PR5 input-side credential filter, branch 1 — confirmation step.
      // The previous submit detected a secret-shape and armed
      // `pendingSecretRedirect`. The `raw` we got is the redirect hint
      // text we put back into the buffer; the user pressing Enter again
      // is consent to forward the masked nudge to the agent. We
      // override `raw` with the fallback message so the engine never
      // sees the original token. Esc-clear is handled in the key
      // handler; that path cancels the redirect and never calls
      // handleSubmit.
      const redirected = consumeArmedRedirect();
      if (redirected !== null) raw = redirected;
      const trimmed = raw.trim();
      setInput(EMPTY_BUFFER);
      historyDraftRef.current = null;
      if (!trimmed) return;
      // Yolo expiry — by-turn (see use-yolo.ts).
      noteTurnStart();
      // Yolo arming intercept. The `/yolo` slash armed the guard; the
      // very next submit must be the literal `yes`. Anything else
      // cancels and goes back to the previous mode without firing the
      // prompt at the engine.
      if (consumeArmAnswer(trimmed)) return;
      // PR5 input-side credential filter, branch 2 — initial detection.
      // Run after we've cleared the field but before the slash /
      // network branches so a pasted secret never reaches the engine
      // even if the user prefixed it with whitespace or a stray slash.
      // Slash commands themselves are unlikely to contain a secret, so
      // we only scan plain-prompt submissions.
      if (!trimmed.startsWith("/")) {
        if (interceptPlainPrompt(trimmed)) return;
      }
      // Slash dispatch — /exit, built-ins, /approve, /reject, /yolo,
      // then the host's onSlash. Consumes anything slash-shaped except
      // path-shaped unknown slashes (`/tmp/report.pdf`).
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
          runYoloSlash,
          runBuiltin: handleBuiltinSlash,
        })
      ) {
        return;
      }

      // Pending-elicitation routing — structured-only confirmation.
      // Free text typed while an elicitation is open is never
      // classified as an answer; forward the user to the structured
      // prompt component instead (see submit-pipeline.ts).
      if (session.pendingElicitation) {
        showPendingElicitationHint(session.pendingElicitation, trimmed, busyRef.current, showInfo);
        return;
      }

      // Plain prompt → drive a turn. Busy-guard first: if a turn is
      // already in flight, enqueue the prompt and let the draining
      // loop pick it up after the current turn completes.
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

      // Record in the in-memory ring + persist (subkit-tenant scoped).
      recordPrompt(trimmed);
      // Captured from the resolved turn so the `finally` drain can tell
      // whether a dialog opened mid-turn — `session` in this closure is
      // stale by then.
      let turnOpenedElicitation = false;
      try {
        setNotices((current) => current.filter((item) => item.tone !== "error"));
        // Synthesize the user-role message BEFORE awaiting onPrompt
        // so the operator sees their input echoed in the transcript
        // immediately. Pre-fix the user typed "3" to pick option 3
        // from the LLM's prose options and waited 1m26s for the
        // assistant to respond before their own message appeared in
        // the scrollback (session 09219b6d). Mirrors how the
        // elicitation pathway already echoes via
        // submitElicitationResponse.
        // De-dupe at the insert site: when the previous message is
        // already a no-id user message with the same content, skip
        // the second optimistic append. Pre-fix re-entrant
        // handleSubmit (e.g. fast double-Enter) produced "› you 1 /
        // › you 1" twice in the transcript before any sk reply
        // (session dcdcf246).
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
        const { events, conversationId } = await onPrompt(finalPrompt, {
          permission_mode: activeMode,
        });
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
      activeMode,
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
      consumeArmAnswer,
      interceptPlainPrompt,
      noteTurnStart,
      recordPrompt,
      runYoloSlash,
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

  // Gate the main composer input while an elicit prompt is open or a
  // modal pane is capturing keys. Without this, each keystroke fires
  // multiple useInput listeners (composer + pane + elicit children)
  // and the user sees the same characters echoed into two places.
  //
  // Exception: the composer stays ACTIVE during an open elicitation
  // as long as the buffered input starts with `/`, so the user can
  // still type `/approve` or `/reject <reason>` and have it dispatch
  // through the slash handler instead of being swallowed by the
  // ConfirmPrompt's digit-shortcuts. Other keys (printable chars that
  // would grow a non-slash prompt) are gated off so the elicit's own
  // keybindings stay authoritative.
  const elicitOpen = session.pendingElicitation !== null;
  // Input-focus contract: at most ONE useInput hook is active at any
  // time. When an elicitation is open, the matching prompt component
  // (ConfirmPrompt / ChoicePrompt / FormPrompt / TextPrompt /
  // MultiChoicePrompt) owns the keyboard via its own useInput, and
  // the composer goes inactive. Without this gate, both the composer
  // and the prompt's useInput fired on every keystroke — keys leaked
  // into the input buffer while the user was trying to drive the
  // approve/reject chooser, producing the "approve / approve / still-
  // waiting" UX bug from session 84d06d81. Slash commands keep working
  // because /approve and /reject are dispatched here directly.
  const composerActive =
    pane === null && !launcherOpen && !historyOpen && !inlineSearchOpen && !elicitOpen;
  const slashMode = input.value.startsWith("/");
  // Slash autocomplete is "navigable" only while the user is still
  // typing the command name (no space yet). Once they add an arg
  // (`/profile prod`), arrow keys go back to history and Tab is inert.
  const slashNavigable = slashMode && !/\s/.test(input.value);
  const slashMatches = useMemo(
    () => (slashNavigable ? searchSlashCommands(input.value, persona.probe, 5) : []),
    [slashNavigable, input.value, persona.probe],
  );
  // Clamp the highlighted index whenever the match list shrinks.
  useEffect(() => {
    if (slashMatches.length === 0) {
      if (slashSelectedIndex !== 0) setSlashSelectedIndex(0);
      return;
    }
    if (slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1);
    }
  }, [slashMatches.length, slashSelectedIndex]);
  // In-progress @mention — drives the inline mention picker.
  const mentionSpec = useMemo(
    () => (composerActive ? extractMention(input.value, input.cursor) : null),
    [composerActive, input.value, input.cursor],
  );
  const showWelcomeActions =
    session.messages.length === 0 && input.value.length === 0 && pane === null && !launcherOpen;

  // -------- Key-input handling --------
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
    setActiveMode,
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

  // Banner once on mount so we don't cover the terminal prompt on
  // exit; clear it after the first prompt submission so the message
  // list gets the vertical space back.
  const showBanner = session.messages.length === 0;

  const welcomeRow = (
    <WelcomeRow
      key="welcome"
      persona={persona}
      conversationId={session.conversationId}
      activeMode={activeMode}
      transcriptMode={transcriptMode}
      connectionSnapshot={connectionSnapshot}
      resumeSummary={resumeSummary}
      statusSnapshot={statusSnapshot}
      setupSnapshot={setupSnapshot}
      digestSnapshot={digestSnapshot}
      tip={tip.current}
      whatsNew={whatsNew}
    />
  );

  const { staticRows, dynamicRows, pagerEntries, elicitFallback } = buildTranscript({
    session,
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
  // Suppress the unused-var warning while the legacy guard is still
  // referenced below (e.g. starter-actions visibility tests).
  void showBanner;
  void showWelcomeActions;

  const content = (
    <Box flexDirection="column">
      <NoticeStack items={notices} />

      {/* Committed scrollback — written once to stdout via Ink Static.
          Survives re-renders, so terminal mouse-selection and copy
          keep working while the live area below keeps ticking. The
          Static bucket holds all finalized messages + tool calls; the
          current-turn dynamic bucket renders separately underneath. */}
      {staticRows.length > 0 ? <Static items={staticRows}>{(row) => row}</Static> : null}
      {/* Live/dynamic transcript — streaming assistant text, running
          tool cards, pending elicit boxes. Kept inside ScrollView so
          long in-flight turns still get windowed. */}
      {dynamicRows.length > 0 ? (
        <ScrollView active={composerActive && pane === null}>{dynamicRows}</ScrollView>
      ) : null}

      {/* Bottom-of-screen elicitation fallback (unanchored) — see
          buildTranscript. */}
      {elicitFallback}

      {/* Modal slot — one pane at a time (/status, /resume browser, …).
          The task launcher renders through `launcherSlot` so its
          stacking position among the panes is unchanged. */}
      <PaneHost
        pane={pane}
        engineClient={engineClient}
        conversationId={session.conversationId}
        messages={session.messages}
        turnTokens={session.usage?.turn_tokens ?? null}
        statusTenantId={statusSnapshot?.tenant.id}
        activeMode={activeMode}
        launcherOpen={launcherOpen}
        onDismiss={() => setPane(null)}
        showInfo={showInfo}
        showError={showError}
        onSelectConversation={onSelectConversation}
        onNewSession={() => setSession(initialSessionState(null))}
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
      {/* Inline Ctrl-R search — above-composer reverse-i-search
          widget. Commits replace the buffer; cancel restores it. */}
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

      {/* Validation errors + thinking spinner — see transcript-cells. */}
      {renderValidationErrorsBlock(session.validationErrors, session.status)}
      {renderTurnSpinner(session.toolCalls, busy, session.usage?.turn_tokens ?? null)}

      {/* Activity ticker — single line above the composer telling the
          operator what the engine is doing right now (current tool,
          composing reply, idle after last tool). Engine emits
          `activity` TurnEvents at meaningful boundaries; the cli-core
          reducer drops them into `session.activity`; the component
          throttles re-renders at 250ms to avoid Ink flicker. Hidden
          when `busy` is false. */}
      <ActivityLine activity={session.activity} active={busy} />

      {/* Modal transcript pager (Ctrl-P toggles).
          Renders every cell with full output and unabridged diffs.
          Returns null when closed; ESC inside it routes to onClose. */}
      <TranscriptPager
        open={pagerOpen}
        entries={pagerEntries}
        onClose={() => setPagerOpen(false)}
        rows={rows}
      />

      {/* Subkit-specific telemetry line — tokens, connector count,
          optional shell-hook output. Sits above the footer so the
          footer's identity chrome stays on the last two rows. */}
      <StatusBar statusLine={statusLine} columns={columns} />

      <PendingPasteRefs items={pendingPasteRefs} />

      {/* Bordered composer — ────── / ❯ input / ────── */}
      <Composer input={input} busy={busy} />

      {/* Two-line footer — subkit identity + permission mode. Holds
          only engine-facing context (user, tenant, engine, session,
          mode); no cwd / model chrome — sk is not an IDE. */}
      <Footer
        user={statusSnapshot?.user.email ?? statusSnapshot?.user.id ?? persona.label}
        tenant={statusSnapshot?.tenant.slug ?? statusSnapshot?.tenant.id ?? persona.tenant}
        engineUrl={persona.engineUrl}
        sessionId={session.conversationId}
        mode={activeMode}
        transcriptMode={transcriptMode}
        connectionState={connectionSnapshot?.state ?? "unknown"}
        connectionReason={connectionSnapshot?.reason ?? null}
        sessionTokens={session.sessionTotalTokens}
        tokensToday={statusSnapshot?.tokens_today ?? null}
        tokensMonth={statusSnapshot?.tokens_month ?? null}
        monthlyBudget={statusSnapshot?.monthly_budget_tokens ?? null}
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

      {/* Inline @-mention picker — shown when the buffer has an
          unresolved `@<query>` token at the cursor. Picks splice the
          chosen value back into the buffer. */}
      {mentionSpec && pane === null && !inlineSearchOpen ? (
        <MentionPicker
          query={mentionSpec.query}
          cwd={cwd ?? process.cwd()}
          onPick={(candidate: MentionCandidate) => {
            setInput((prev) => {
              const next = applyMention(prev.value, prev.cursor, mentionSpec.start, candidate);
              return { value: next.value, cursor: next.cursor };
            });
          }}
          onDismiss={() => {
            // Soft dismiss — leave the `@<query>` token untouched and
            // let the user keep typing. The picker will re-render when
            // the token changes.
          }}
        />
      ) : null}

      {/* Queued-commands indicator — shows when the user typed more
          prompts while the turn was running. Drained FIFO once the
          current turn finishes. */}
      {queuedCount > 0 ? (
        <Box>
          <Text color="yellow">⏸ </Text>
          <Text dimColor>{queuedCount} queued — drains when turn completes</Text>
        </Box>
      ) : null}

      {/* Prefix slash-command suggestions (hidden while a pane is open).
          The legacy SuggestionList drives ranked picks once the user
          starts typing; the new SlashSuggest adds the discovery
          welcome hint when the buffer is empty so first-time users
          stop guessing at /. */}
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

      {/* Double-Ctrl-C exit flow (always-on input — even when a pane captures keys) */}
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
