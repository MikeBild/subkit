// Composer key-input handling for the Ink REPL.
//
// The single `useInput` hook that owns the keyboard while the
// composer is active: global shortcuts (pager, alt-screen, view and
// permission-mode toggles), ghost-text accept/dismiss, Esc routing
// (secret-redirect cancel → turn interrupt → notice dismiss),
// next-best-action chips, welcome starter actions, slash-suggestion
// navigation, history navigation, readline-style cursor/kill
// bindings, newline-vs-submit, and the bracketed-paste heuristics.
//
// Everything arrives through the typed `ComposerKeyDeps` interface —
// the hook holds no state of its own beyond what Ink's useInput needs.

import type { PendingElicitation } from "@cli-core/index.ts";
import { useInput, useStdout } from "ink";
import type React from "react";

import type { EngineClient } from "../engine-client.ts";
import {
  apply as applyInput,
  buffer,
  cursorPosition,
  EMPTY_BUFFER,
  type InputBuffer,
  lineEnd,
  lineStart,
  splitLines,
} from "../repl/input-buffer.ts";
import type { extractMention } from "../repl/mention-picker.tsx";
import { looksLikePaste } from "../repl/paste-store.ts";
import type { PaneSpec } from "../repl/slash/handler.ts";
import type { PermissionMode } from "../repl/status-line/render.ts";
import { resolveTaskActionSuggestion, type TaskAction } from "../repl/task-actions.ts";
import type { SlashCommand } from "../slash.ts";
import type { TranscriptMode } from "./types.ts";
import type { TranscriptNotice } from "./use-notices.ts";

export interface ComposerKeyDeps {
  // --- Composer buffer ---
  input: InputBuffer;
  setInput: React.Dispatch<React.SetStateAction<InputBuffer>>;
  insertPasteChunk: (pasted: string) => void;
  /** Ink `isActive` gate — at most ONE useInput hook is live at a time. */
  composerActive: boolean;
  // --- Session / engine ---
  conversationId: string | null;
  engineClient: EngineClient | undefined;
  pendingElicitation: PendingElicitation | null;
  busyRef: React.MutableRefObject<boolean>;
  onCancelConversation: ((conversationId: string) => Promise<unknown>) | undefined;
  // --- Ghost text ---
  ghostHandledRef: React.MutableRefObject<boolean>;
  // --- Slash suggestions ---
  slashNavigable: boolean;
  slashMatches: SlashCommand[];
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  // --- History ring ---
  historyRef: React.MutableRefObject<string[]>;
  historyCursorRef: React.MutableRefObject<number>;
  historyDraftRef: React.MutableRefObject<InputBuffer | null>;
  // --- Modal / overlay state ---
  pane: PaneSpec | null;
  setPane: (spec: PaneSpec | null) => void;
  notices: TranscriptNotice[];
  dismissNotice: () => void;
  inlineSearchOpen: boolean;
  setInlineSearchOpen: (open: boolean) => void;
  setPagerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAltScreen: React.Dispatch<React.SetStateAction<boolean>>;
  setTranscriptMode: React.Dispatch<React.SetStateAction<TranscriptMode>>;
  setActiveMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  // --- Secret redirect ---
  secretRedirectArmed: boolean;
  cancelSecretRedirect: () => void;
  // --- Actions / dispatch ---
  latestChipsRef: React.MutableRefObject<string[]>;
  invokeTaskAction: (action: TaskAction, mode?: "prefill" | "submit") => void;
  handleSubmit: (raw: string) => Promise<void>;
  showWelcomeActions: boolean;
  starterTaskActions: readonly TaskAction[];
  mentionSpec: ReturnType<typeof extractMention>;
  showInfo: (message: string) => void;
}

export function useComposerKeys(deps: ComposerKeyDeps): void {
  const {
    input,
    setInput,
    insertPasteChunk,
    composerActive,
    conversationId,
    engineClient,
    pendingElicitation,
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
    secretRedirectArmed,
    cancelSecretRedirect,
    latestChipsRef,
    invokeTaskAction,
    handleSubmit,
    showWelcomeActions,
    starterTaskActions,
    mentionSpec,
    showInfo,
  } = deps;
  const { stdout } = useStdout();
  const pendingElicit = pendingElicitation;
  const elicitOpen = pendingElicitation !== null;

  useInput(
    (char, key) => {
      // --- Global shortcuts (active even under modal / busy) ----------
      // Ctrl-P toggles the transcript pager — a modal showing
      // every cell with full output / full diff. Distinct from the
      // alt-screen inspect mode (Ctrl-T) which is a different rendering.
      if (key.ctrl && char === "p") {
        setPagerOpen((prev) => !prev);
        return;
      }
      if (key.ctrl && char === "t") {
        setAltScreen((prev) => !prev);
        return;
      }
      if (key.ctrl && char === "o") {
        setTranscriptMode((mode) => {
          const next = mode === "chat" ? "inspect" : "chat";
          showInfo(`/view: ${next}`);
          return next;
        });
        return;
      }
      if (key.shift && key.tab) {
        setActiveMode((m) => {
          const next = m === "ask" ? "auto" : m === "auto" ? "plan" : "ask";
          showInfo(`/mode: ${next}`);
          return next;
        });
        return;
      }
      // --- Ghost-text accept / dismiss --------------------------------
      // The next-message preview rides on `input.ghost`. Right-Arrow at
      // end-of-input accepts the full remainder; Tab does the same when
      // no slash-suggest popover is showing (slash-suggest's own Tab
      // handler runs lower down and wins precedence). Esc dismisses.
      // Each branch fires a fire-and-forget feedback POST so dashboards
      // can pivot accept-rate per tenant.
      if (input.ghost) {
        const cid = conversationId;
        if (key.rightArrow && input.cursor === input.value.length) {
          ghostHandledRef.current = true;
          setInput((prev) => applyInput(prev, { type: "ghostAccept" }));
          if (cid && engineClient) {
            void engineClient.submitSuggestionFeedback(cid, {
              accepted: true,
              source: "right-arrow",
            });
          }
          // Slash-kind suggestions land in the buffer as `/skill ...`
          // and the existing slash dispatcher picks them up on the
          // next Enter — no special-case routing needed here.
          return;
        }
        if (key.tab && (!slashNavigable || slashMatches.length === 0)) {
          ghostHandledRef.current = true;
          setInput((prev) => applyInput(prev, { type: "ghostAccept" }));
          if (cid && engineClient) {
            void engineClient.submitSuggestionFeedback(cid, { accepted: true, source: "tab" });
          }
          return;
        }
        if (key.escape) {
          ghostHandledRef.current = true;
          setInput((prev) => applyInput(prev, { type: "ghostClear" }));
          if (cid && engineClient) {
            void engineClient.submitSuggestionFeedback(cid, {
              accepted: false,
              source: "dismissed",
            });
          }
          return;
        }
      }
      // Ctrl-R opens inline history-search (an above-composer
      // widget). The modal pane is still reachable
      // via `/resume` for users who prefer it.
      if (key.ctrl && char === "r") {
        if (historyRef.current.length > 0) setInlineSearchOpen(true);
        return;
      }
      // Ctrl-L clears the terminal scroll buffer. Route through Ink's
      // own stdout handle so the ANSI escape interleaves with the
      // render tree instead of fighting it.
      if (key.ctrl && char === "l") {
        stdout?.write("\x1b[2J\x1b[H");
        return;
      }
      // PR5 input-side credential filter: Esc clears an armed redirect
      // without sending anything. Highest-priority Esc handler so the
      // user can always bail out of a paste-was-detected prompt.
      if (key.escape && secretRedirectArmed) {
        cancelSecretRedirect();
        return;
      }
      // Esc-to-interrupt for a long-running turn.
      // Routes to the engine's cancel endpoint via the conversation
      // id; the running stream sees its abort signal fire and the
      // turn ends with a `cancelled` status. Only fires when the CLI
      // is actually busy (busyRef) AND no other Esc-consumer is
      // armed (no pending elicit, no notice, no pane).
      if (
        key.escape &&
        busyRef.current &&
        pendingElicit === null &&
        pane === null &&
        !inlineSearchOpen
      ) {
        const cid = conversationId;
        if (cid && onCancelConversation) {
          showInfo("interrupting current turn — esc pressed");
          void onCancelConversation(cid).catch(() => {
            /* engine logs the failure; CLI surfaces the abort UX regardless */
          });
        }
        return;
      }
      if (
        key.escape &&
        notices.some((item) => item.persistent) &&
        pane === null &&
        !inlineSearchOpen
      ) {
        dismissNotice();
        return;
      }
      if (busyRef.current) {
        // While busy, still accept keystrokes into the buffer so the
        // user can type ahead. Enter enqueues instead of spawning a
        // concurrent turn (see handleSubmit).
      }
      // Belt + braces: composerActive already excludes elicitOpen so
      // this hook never fires while a prompt component owns input.
      // Keep the guard in case isActive lags one frame behind a
      // freshly-arrived elicit_request event.
      if (elicitOpen) return;

      // When the portal-token pane is open, 'y' copies the (one-shot)
      // URL to the OS clipboard via OSC 52. The pane closes after
      // copy so the bytes never sit on screen longer than necessary.
      if (pane?.kind === "portal-token" && (char === "y" || char === "Y")) {
        const url = pane.url;
        void import("@cli-core/clipboard.ts").then(({ osc52Copy }) => {
          osc52Copy(url);
        });
        showInfo("portal URL copied to clipboard");
        setPane(null);
        return;
      }

      // --- Next-best-actions chip shortcut (digits 1..9) -------------
      // Wins over the welcome-action shortcut below: a freshly-failed
      // tool with chips might land in a session that hasn't pushed an
      // assistant message yet (so showWelcomeActions is still true),
      // and the operator should still be able to press 1..9 to run the
      // suggested action. Empty-input gate is unchanged so the
      // shortcut never breaks numeric input the user is typing.
      if (
        char &&
        char.length === 1 &&
        char >= "1" &&
        char <= "9" &&
        !key.ctrl &&
        !key.meta &&
        input.value.length === 0 &&
        latestChipsRef.current.length > 0
      ) {
        const chipIdx = char.charCodeAt(0) - "1".charCodeAt(0);
        const action = latestChipsRef.current[chipIdx];
        if (action) {
          const mapped = resolveTaskActionSuggestion(action);
          if (mapped) invokeTaskAction(mapped, "submit");
          else void handleSubmit(`please run ${action}`);
          return;
        }
      }

      if (showWelcomeActions && char && !key.ctrl && !key.meta) {
        const picked = starterTaskActions.find((action) => action.key === char);
        if (picked) {
          invokeTaskAction(picked, "prefill");
          return;
        }
      }

      // --- Slash-suggestion navigation (precedes history) ------------
      // Only intercept arrows while the user is still typing the
      // command name (no whitespace) and the match list is non-empty.
      // Otherwise ↑/↓ fall through to history navigation below.
      if (slashNavigable && slashMatches.length > 0) {
        if (key.upArrow) {
          setSlashSelectedIndex((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
          return;
        }
        if (key.downArrow) {
          setSlashSelectedIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (key.tab) {
          const picked = slashMatches[slashSelectedIndex] ?? slashMatches[0];
          if (picked) {
            const next = `/${picked.name} `;
            setInput(buffer(next));
          }
          return;
        }
      }

      // --- History navigation via arrow keys -------------------------
      if (key.upArrow) {
        // Mention picker wraps Up/Down itself; if a mention is open
        // and the picker captured nothing, fall through to history
        // only when the buffer is on the first row.
        if (mentionSpec) return;
        const pos = cursorPosition(input);
        if (pos.row > 0) {
          // Move up one row within the buffer instead of cycling history.
          const targetOffset = Math.max(0, input.cursor - pos.column - 1);
          setInput(applyInput(input, { type: "set", value: input.value, cursor: targetOffset }));
          return;
        }
        if (historyRef.current.length === 0) return;
        if (historyCursorRef.current === historyRef.current.length && input.value.length > 0) {
          historyDraftRef.current = input;
        }
        const next = Math.max(0, historyCursorRef.current - 1);
        historyCursorRef.current = next;
        const entry = historyRef.current[next] ?? "";
        setInput(buffer(entry));
        return;
      }
      if (key.downArrow) {
        if (mentionSpec) return;
        const pos = cursorPosition(input);
        const totalRows = splitLines(input.value).length;
        if (pos.row < totalRows - 1) {
          const thisEnd = lineEnd(input.value, input.cursor);
          const nextStart = thisEnd + 1;
          const nextEnd = lineEnd(input.value, nextStart);
          const targetOffset = Math.min(
            nextEnd,
            nextStart + (input.cursor - lineStart(input.value, input.cursor)),
          );
          setInput(applyInput(input, { type: "set", value: input.value, cursor: targetOffset }));
          return;
        }
        if (historyRef.current.length === 0) return;
        const next = Math.min(historyRef.current.length, historyCursorRef.current + 1);
        historyCursorRef.current = next;
        if (next === historyRef.current.length) {
          // Past the newest entry — restore the stashed draft (if any)
          // or land on an empty buffer.
          setInput(historyDraftRef.current ?? EMPTY_BUFFER);
          historyDraftRef.current = null;
        } else {
          setInput(buffer(historyRef.current[next] ?? ""));
        }
        return;
      }

      // --- Cursor navigation -----------------------------------------
      if (key.leftArrow) {
        if (key.meta || key.ctrl) {
          setInput((prev) => applyInput(prev, { type: "moveWordLeft" }));
        } else {
          setInput((prev) => applyInput(prev, { type: "moveLeft" }));
        }
        return;
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) {
          setInput((prev) => applyInput(prev, { type: "moveWordRight" }));
        } else {
          setInput((prev) => applyInput(prev, { type: "moveRight" }));
        }
        return;
      }
      // Home / End — physical keys jump to start/end of the WHOLE buffer
      // (distinct from the line-aware Ctrl-A/E below, which stop at the
      // current line in a multi-line draft). Ink 7 surfaces key.home/end.
      if (key.home) {
        setInput((prev) => applyInput(prev, { type: "moveHome" }));
        return;
      }
      if (key.end) {
        setInput((prev) => applyInput(prev, { type: "moveEnd" }));
        return;
      }
      // Ctrl-A / Ctrl-E — readline line start/end
      if (key.ctrl && char === "a") {
        setInput((prev) => applyInput(prev, { type: "moveLineStart" }));
        return;
      }
      if (key.ctrl && char === "e") {
        setInput((prev) => applyInput(prev, { type: "moveLineEnd" }));
        return;
      }
      // Readline-style kill bindings
      if (key.ctrl && char === "u") {
        setInput((prev) => applyInput(prev, { type: "killLine" }));
        return;
      }
      if (key.ctrl && char === "k") {
        setInput((prev) => applyInput(prev, { type: "killToEnd" }));
        return;
      }
      if (key.ctrl && char === "w") {
        setInput((prev) => applyInput(prev, { type: "killPrevWord" }));
        return;
      }
      // Alt / Meta Backspace — also "kill previous word" (terminal may
      // send `\x1b` + DEL or similar; Ink normalizes it to meta + delete).
      if (key.meta && (key.backspace || key.delete)) {
        setInput((prev) => applyInput(prev, { type: "killPrevWord" }));
        return;
      }
      // Alt+D — kill next word (emacs / bash convention)
      if (key.meta && char === "d") {
        setInput((prev) => applyInput(prev, { type: "killNextWord" }));
        return;
      }

      // --- Newline vs submit ----------------------------------------
      // Three ways to insert a newline (multi-line drafting), one to
      // submit:
      //
      //   - Ctrl-J (line feed) — the tmux / emacs convention, works on
      //     every terminal because the byte is unambiguous.
      //   - Shift+Enter — only delivered as a distinct
      //     event on terminals that speak the kitty keyboard protocol
      //     (kitty, ghostty, recent iTerm2, foot, alacritty with
      //     `keyboard_protocol = enabled`). On classic terminals
      //     shift+enter is indistinguishable from plain enter and this
      //     branch never fires; the user falls back to ctrl-j.
      //   - Backslash + Enter — universal escape that works on every
      //     terminal: typing `\` then Enter strips the trailing
      //     backslash and inserts a newline. Mirrors shell heredoc /
      //     readline line-continuation semantics so power users can
      //     type multi-line drafts without leaving the home row.
      //
      // Plain Enter (carriage return, no shift) submits the buffer.
      if (key.ctrl && char === "j") {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.shift && key.return) {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.return) {
        // Backslash + Enter line-continuation: strip the trailing `\`
        // and insert a newline. Only fires when the cursor is past a
        // single trailing backslash (avoids munging "C:\foo" pastes
        // mid-line).
        if (
          input.cursor === input.value.length &&
          input.value.endsWith("\\") &&
          !input.value.endsWith("\\\\")
        ) {
          setInput((prev) =>
            applyInput(prev, {
              type: "set",
              value: `${prev.value.slice(0, -1)}\n`,
              cursor: prev.value.length, // length of trimmed-then-newlined buffer
            }),
          );
          return;
        }
        // Slash autocomplete: when the user is still typing the
        // command name and a suggestion is highlighted, Enter submits
        // the highlighted command instead of whatever exact prefix the
        // buffer holds. Saves a Tab keystroke for the common case.
        if (slashNavigable && slashMatches.length > 0) {
          const picked = slashMatches[slashSelectedIndex] ?? slashMatches[0];
          if (picked) {
            void handleSubmit(`/${picked.name}`);
            return;
          }
        }
        void handleSubmit(input.value);
        return;
      }

      // --- Backspace / delete ---------------------------------------
      if (key.backspace) {
        setInput((prev) => applyInput(prev, { type: "deletePrev" }));
        return;
      }
      if (key.delete) {
        setInput((prev) => applyInput(prev, { type: "deleteNext" }));
        return;
      }

      // --- Printable char(s) / paste heuristic ----------------------
      if (char && char.length > 0 && !key.ctrl && !key.meta) {
        // Bracketed paste: the terminal frames pastes with
        // ESC[200~…ESC[201~. Strip both markers and treat whatever was
        // between them as a paste, regardless of length. Stops
        // multi-line pastes from being fragmented into per-char key
        // events.
        const BP_START = "\x1b[200~";
        const BP_END = "\x1b[201~";
        const startIdx = char.indexOf(BP_START);
        const endIdx = char.lastIndexOf(BP_END);
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          const pasted = char.slice(startIdx + BP_START.length, endIdx);
          const prefix = char.slice(0, startIdx);
          const suffix = char.slice(endIdx + BP_END.length);
          if (prefix) setInput((prev) => applyInput(prev, { type: "insert", text: prefix }));
          if (pasted) {
            insertPasteChunk(pasted);
          }
          if (suffix) setInput((prev) => applyInput(prev, { type: "insert", text: suffix }));
          return;
        }
        if (char.length > 1 && looksLikePaste(char)) {
          // Short single-line pastes (typical "copy a name / id"
          // workflow) are inlined verbatim — no attachment, no
          // `[Pasted text #N]` ref. The attachment indirection only
          // earns its keep when the paste is multi-line OR very long;
          // forcing it on a 6-character word produced the confusing
          // `[2] text · 1 line · acme-stock-price` dialog over the
          // composer in session 64db7189.
          insertPasteChunk(char);
          return;
        }
        setInput((prev) => applyInput(prev, { type: "insert", text: char }));
      }
    },
    { isActive: composerActive },
  );
}
