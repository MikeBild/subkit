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
  input: InputBuffer;
  setInput: React.Dispatch<React.SetStateAction<InputBuffer>>;
  insertPasteChunk: (pasted: string) => void;
  composerActive: boolean;
  conversationId: string | null;
  engineClient: EngineClient | undefined;
  pendingElicitation: PendingElicitation | null;
  busyRef: React.MutableRefObject<boolean>;
  onCancelConversation: ((conversationId: string) => Promise<unknown>) | undefined;
  ghostHandledRef: React.MutableRefObject<boolean>;
  slashNavigable: boolean;
  slashMatches: SlashCommand[];
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  historyRef: React.MutableRefObject<string[]>;
  historyCursorRef: React.MutableRefObject<number>;
  historyDraftRef: React.MutableRefObject<InputBuffer | null>;
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
  secretRedirectArmed: boolean;
  cancelSecretRedirect: () => void;
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
      if (key.ctrl && char === "r") {
        if (historyRef.current.length > 0) setInlineSearchOpen(true);
        return;
      }
      if (key.ctrl && char === "l") {
        stdout?.write("\x1b[2J\x1b[H");
        return;
      }
      if (key.escape && secretRedirectArmed) {
        cancelSecretRedirect();
        return;
      }
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
          void onCancelConversation(cid).catch(() => {});
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
      }
      if (elicitOpen) return;

      if (pane?.kind === "portal-token" && (char === "y" || char === "Y")) {
        const url = pane.url;
        void import("@cli-core/clipboard.ts").then(({ osc52Copy }) => {
          osc52Copy(url);
        });
        showInfo("portal URL copied to clipboard");
        setPane(null);
        return;
      }

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

      if (key.upArrow) {
        if (mentionSpec) return;
        const pos = cursorPosition(input);
        if (pos.row > 0) {
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
          setInput(historyDraftRef.current ?? EMPTY_BUFFER);
          historyDraftRef.current = null;
        } else {
          setInput(buffer(historyRef.current[next] ?? ""));
        }
        return;
      }

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
      if (key.home) {
        setInput((prev) => applyInput(prev, { type: "moveHome" }));
        return;
      }
      if (key.end) {
        setInput((prev) => applyInput(prev, { type: "moveEnd" }));
        return;
      }
      if (key.ctrl && char === "a") {
        setInput((prev) => applyInput(prev, { type: "moveLineStart" }));
        return;
      }
      if (key.ctrl && char === "e") {
        setInput((prev) => applyInput(prev, { type: "moveLineEnd" }));
        return;
      }
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
      if (key.meta && (key.backspace || key.delete)) {
        setInput((prev) => applyInput(prev, { type: "killPrevWord" }));
        return;
      }
      if (key.meta && char === "d") {
        setInput((prev) => applyInput(prev, { type: "killNextWord" }));
        return;
      }

      if (key.ctrl && char === "j") {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.shift && key.return) {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.return) {
        if (
          input.cursor === input.value.length &&
          input.value.endsWith("\\") &&
          !input.value.endsWith("\\\\")
        ) {
          setInput((prev) =>
            applyInput(prev, {
              type: "set",
              value: `${prev.value.slice(0, -1)}\n`,
              cursor: prev.value.length,
            }),
          );
          return;
        }
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

      if (key.backspace) {
        setInput((prev) => applyInput(prev, { type: "deletePrev" }));
        return;
      }
      if (key.delete) {
        setInput((prev) => applyInput(prev, { type: "deleteNext" }));
        return;
      }

      if (char && char.length > 0 && !key.ctrl && !key.meta) {
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
          insertPasteChunk(char);
          return;
        }
        setInput((prev) => applyInput(prev, { type: "insert", text: char }));
      }
    },
    { isActive: composerActive },
  );
}
