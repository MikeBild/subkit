// Composer-adjacent state machines for the Ink REPL.
//
// Four hooks that own the stateful machinery around the input buffer:
//
//   * usePromptHistory   — persistent ↑/↓ prompt ring (~/.sk/history.jsonl)
//   * usePasteBuffers    — paste store + `[Pasted text #N]` ref chips
//   * useSecretRedirect  — input-side credential filter (PR5)
//   * useGhostFeedback   — ghost-text accept/typed-over telemetry
//
// Each hook owns its state and exposes a small verb surface so the
// submit path and key handler stay orchestration-only.

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient } from "../engine-client.ts";
import {
  detectSecretShape,
  REQUEST_CREDENTIAL_FORM_FALLBACK,
  secretRedirectHint,
} from "../lib/secret-shape.ts";
import { appendHistory, defaultHistoryPath, loadPromptRing } from "../repl/history-store.ts";
import {
  apply as applyInput,
  buffer,
  EMPTY_BUFFER,
  type InputBuffer,
} from "../repl/input-buffer.ts";
import {
  createPasteStore,
  expandRefs,
  looksLikePaste,
  type PasteStore,
  type StoredPaste,
} from "../repl/paste-store.ts";

// -------- Persistent prompt history --------

export interface PromptHistoryApi {
  historyRef: React.MutableRefObject<string[]>;
  historyCursorRef: React.MutableRefObject<number>;
  /** Draft preservation — when the user presses ↑ on a non-empty
   *  buffer, stash the in-progress draft so ↓-past-zero restores it. */
  historyDraftRef: React.MutableRefObject<InputBuffer | null>;
  effectiveHistoryPath: string;
  /** Record in the in-memory ring + persist (subkit-tenant scoped). */
  recordPrompt: (trimmed: string) => void;
}

// Load ~/.sk/history.jsonl on mount so ↑/↓ works across sessions.
// The ring is kept as a ref so rapid keypresses don't trigger
// re-renders on every navigation.
export function usePromptHistory(
  historyPath: string | undefined,
  tenant: string | null,
): PromptHistoryApi {
  const historyRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number>(0);
  const historyDraftRef = useRef<InputBuffer | null>(null);
  const effectiveHistoryPath = historyPath ?? defaultHistoryPath();
  useEffect(() => {
    try {
      const ring = loadPromptRing(effectiveHistoryPath, { tenant });
      historyRef.current = ring;
      historyCursorRef.current = ring.length;
    } catch {
      // silent — missing / locked file shouldn't crash the REPL
    }
  }, [effectiveHistoryPath, tenant]);
  const recordPrompt = useCallback(
    (trimmed: string): void => {
      historyRef.current.push(trimmed);
      historyCursorRef.current = historyRef.current.length;
      try {
        appendHistory(trimmed, { path: effectiveHistoryPath, tenant: tenant ?? null });
      } catch {
        // best-effort
      }
    },
    [effectiveHistoryPath, tenant],
  );
  return { historyRef, historyCursorRef, historyDraftRef, effectiveHistoryPath, recordPrompt };
}

// -------- Paste store --------

export interface PasteBuffersApi {
  pasteStoreRef: React.MutableRefObject<PasteStore>;
  pendingPasteRefs: StoredPaste[];
  syncPendingPasteRefs: () => void;
  insertPasteChunk: (pasted: string) => void;
}

export function usePasteBuffers(
  setInput: React.Dispatch<React.SetStateAction<InputBuffer>>,
  showInfo: (message: string) => void,
): PasteBuffersApi {
  const pasteStoreRef = useRef<PasteStore>(createPasteStore());
  const [pendingPasteRefs, setPendingPasteRefs] = useState<StoredPaste[]>([]);
  const syncPendingPasteRefs = useCallback(() => {
    setPendingPasteRefs([...pasteStoreRef.current.all()]);
  }, []);
  const insertPasteChunk = useCallback(
    (pasted: string): void => {
      if (!looksLikePaste(pasted)) {
        setInput((prev) => applyInput(prev, { type: "insert", text: pasted }));
        return;
      }
      const normalized = pasted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const { ref } = pasteStoreRef.current.addText(normalized);
      syncPendingPasteRefs();
      setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
      showInfo(`pasted ${ref} — sent inline at submit`);
    },
    [showInfo, syncPendingPasteRefs],
  );
  return { pasteStoreRef, pendingPasteRefs, syncPendingPasteRefs, insertPasteChunk };
}

// -------- Input-side credential filter (PR5) --------
//
// When the user pastes a token-shaped string, the composer suppresses
// the send, replaces the input field with a redirect hint, and arms
// this state. The next Enter sends a structured nudge
// (REQUEST_CREDENTIAL_FORM_FALLBACK) to the engine instead of the raw
// paste so the agent re-collects through `ask_user_form(type:
// password, sensitive: true)`. Esc clears it without sending
// anything. Only the kind name + 6-char prefix sample ever surface in
// the UI; the matched secret is dropped on the floor and never leaves
// this process.

export interface SecretRedirectApi {
  pendingSecretRedirect: { kind: string; sample: string } | null;
  /**
   * Branch 1 — confirmation step. The previous submit detected a
   * secret-shape and armed the redirect; the raw the composer holds is
   * the hint text we put back into the buffer, and the user pressing
   * Enter again is consent to forward the masked nudge to the agent.
   * Returns the fallback message to submit in place of `raw` (so the
   * engine never sees the original token), or `null` when not armed.
   */
  consumeArmedRedirect: () => string | null;
  /**
   * Branch 2 — initial detection on a plain (non-slash) prompt.
   * Scans both the literal buffer AND the paste-expanded form so a
   * long paste that got stashed under `[Pasted text #N]` is still
   * caught — the paste store is what actually goes on the wire.
   * Returns true when the submission was swallowed.
   */
  interceptPlainPrompt: (trimmed: string) => boolean;
  /** Esc path — clears an armed redirect without sending anything. */
  cancelSecretRedirect: () => void;
}

export function useSecretRedirect(
  pasteStoreRef: React.MutableRefObject<PasteStore>,
  syncPendingPasteRefs: () => void,
  setInput: React.Dispatch<React.SetStateAction<InputBuffer>>,
  showInfo: (message: string) => void,
): SecretRedirectApi {
  const [pendingSecretRedirect, setPendingSecretRedirect] = useState<{
    kind: string;
    sample: string;
  } | null>(null);

  const consumeArmedRedirect = useCallback((): string | null => {
    if (pendingSecretRedirect === null) return null;
    setPendingSecretRedirect(null);
    // Fall through with the masked nudge instead of the literal
    // hint. The agent's connector-creation skill already routes
    // any credential request through `ask_user_form(type: password,
    // sensitive: true)`, so a plain re-prompt is enough — see
    // apps/engine/src/conversations/seed/skills/connector-creation-guidance.md.
    // Engine-route decision: we kept the fallback path instead of
    // adding a `request_credential_form` event type to the engine
    // HTTP route. The engine has no schema for that event yet, and
    // the agent's existing skill set already does the right thing
    // when re-asked in plain language. Future PR can promote this
    // to a typed event without changing the CLI.
    showInfo("forwarding masked credential request to the agent");
    return REQUEST_CREDENTIAL_FORM_FALLBACK;
  }, [pendingSecretRedirect, showInfo]);

  const interceptPlainPrompt = useCallback(
    (trimmed: string): boolean => {
      let shape = detectSecretShape(trimmed);
      if (!shape.matched) {
        const { prompt: probeExpanded } = expandRefs(trimmed, pasteStoreRef.current);
        if (probeExpanded !== trimmed) {
          shape = detectSecretShape(probeExpanded);
        }
      }
      if (shape.matched) {
        // Stash kind + 6-char sample only — the matched secret is
        // dropped here and never logged. Replace the buffer with a
        // human-readable hint the user can confirm or cancel. The
        // hint contains the sample (6 chars) but not the full token.
        // We also drop any paste-store entries that contained the
        // secret so they can't leak via a later @-mention or queue.
        for (const item of pasteStoreRef.current.all()) {
          if (item.kind === "text" && detectSecretShape(item.text).matched) {
            pasteStoreRef.current.delete(item.id);
          }
        }
        syncPendingPasteRefs();
        setPendingSecretRedirect({ kind: shape.kind, sample: shape.sample });
        setInput(buffer(secretRedirectHint(shape)));
        return true;
      }
      return false;
    },
    [pasteStoreRef, setInput, syncPendingPasteRefs],
  );

  // PR5 input-side credential filter: Esc clears an armed redirect
  // without sending anything.
  const cancelSecretRedirect = useCallback((): void => {
    setPendingSecretRedirect(null);
    setInput(EMPTY_BUFFER);
    showInfo("credential paste cancelled");
  }, [setInput, showInfo]);

  return {
    pendingSecretRedirect,
    consumeArmedRedirect,
    interceptPlainPrompt,
    cancelSecretRedirect,
  };
}

// -------- Ghost-text feedback --------

export interface GhostFeedbackApi {
  /** Set true by the explicit Right-Arrow / Tab / Esc handlers before
   *  they call setInput, so the post-render effect knows that branch
   *  already fired feedback and skips the implicit `typed-over`
   *  emission. Without this we'd double-count every right-arrow
   *  accept as both "accepted" and "typed-over". */
  ghostHandledRef: React.MutableRefObject<boolean>;
}

export function useGhostFeedback(
  input: InputBuffer,
  conversationId: string | null,
  engineClient: EngineClient | undefined,
): GhostFeedbackApi {
  // Tracks the ghost across renders so we can detect the
  // "user typed the entire suggestion" transition. The reducer drops
  // the ghost once `consumed === text.length` (input-buffer.ts:181).
  const prevGhostRef = useRef<{ text: string } | null>(null);
  const ghostHandledRef = useRef(false);

  // Detect the "user typed the entire suggestion" transition. The
  // input-buffer reducer drops the ghost the moment `consumed`
  // reaches `text.length`; without this effect the matching feedback
  // outcome (`typed_over`) would never fire and the dashboard pivot
  // would stay flat. Right-Arrow / Tab / Esc set `ghostHandledRef`
  // so we don't double-count an explicit accept as also typed-over.
  useEffect(() => {
    const prev = prevGhostRef.current;
    if (prev && !input.ghost) {
      if (!ghostHandledRef.current && input.value === prev.text && input.value.length > 0) {
        const cid = conversationId;
        if (cid && engineClient) {
          void engineClient.submitSuggestionFeedback(cid, {
            accepted: true,
            source: "typed-over",
          });
        }
      }
      ghostHandledRef.current = false;
    }
    prevGhostRef.current = input.ghost ? { text: input.ghost.text } : null;
  }, [input.ghost, input.value, conversationId, engineClient]);

  // Drop the ghost-tracking refs when the active conversation switches
  // (resume / fork / new). Without this, a stale ghost from the prior
  // conversation could fire a `typed-over` POST against the wrong
  // conversation_id during fast tab-switching: prevGhostRef holds
  // text, the user types matching prefix in the new conversation, the
  // typed-over branch above POSTs against `session.conversationId`
  // (now the new conversation) with the prior ghost's text. Clearing
  // here closes that window.
  useEffect(() => {
    prevGhostRef.current = null;
    ghostHandledRef.current = false;
  }, [conversationId]);

  return { ghostHandledRef };
}
