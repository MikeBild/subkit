import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineClient, RequestCredentialFormEvent } from "../engine-client.ts";
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

interface PromptHistoryApi {
  historyRef: React.MutableRefObject<string[]>;
  historyCursorRef: React.MutableRefObject<number>;
  historyDraftRef: React.MutableRefObject<InputBuffer | null>;
  effectiveHistoryPath: string;
  recordPrompt: (trimmed: string) => void;
}

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
    } catch {}
  }, [effectiveHistoryPath, tenant]);
  const recordPrompt = useCallback(
    (trimmed: string): void => {
      historyRef.current.push(trimmed);
      historyCursorRef.current = historyRef.current.length;
      try {
        appendHistory(trimmed, { path: effectiveHistoryPath, tenant: tenant ?? null });
      } catch {}
    },
    [effectiveHistoryPath, tenant],
  );
  return { historyRef, historyCursorRef, historyDraftRef, effectiveHistoryPath, recordPrompt };
}

interface PasteBuffersApi {
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

interface SecretRedirectApi {
  pendingSecretRedirect: { kind: string; sample: string } | null;
  consumeArmedRedirect: () => { message: string; event: RequestCredentialFormEvent } | null;
  interceptPlainPrompt: (trimmed: string) => boolean;
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

  const consumeArmedRedirect = useCallback((): {
    message: string;
    event: RequestCredentialFormEvent;
  } | null => {
    if (pendingSecretRedirect === null) return null;
    setPendingSecretRedirect(null);
    showInfo("forwarding masked credential request to the agent");
    return {
      message: REQUEST_CREDENTIAL_FORM_FALLBACK,
      event: { type: "request_credential_form", credential_hint: pendingSecretRedirect.kind },
    };
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

interface GhostFeedbackApi {
  ghostHandledRef: React.MutableRefObject<boolean>;
}

export function useGhostFeedback(
  input: InputBuffer,
  conversationId: string | null,
  engineClient: EngineClient | undefined,
): GhostFeedbackApi {
  const prevGhostRef = useRef<{ text: string } | null>(null);
  const ghostHandledRef = useRef(false);

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

  useEffect(() => {
    prevGhostRef.current = null;
    ghostHandledRef.current = false;
  }, [conversationId]);

  return { ghostHandledRef };
}
