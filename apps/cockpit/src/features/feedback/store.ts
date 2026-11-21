import { useSyncExternalStore } from "react";
import {
  appendClientError,
  clientErrorCode,
  type FeedbackDraft,
  type FeedbackFailure,
  type FeedbackKind,
  type FeedbackRecentError,
  hasFeedbackDraft,
  mergePrefill,
  newFeedbackDraft,
  readStoredDraft,
  type ScreenshotCapability,
  writeStoredDraft,
} from "@/features/feedback/model/feedback";
import { CAPTURE_TIMEOUT_MS, type FeedbackBridge, feedbackBridge, within } from "./desktop-bridge";

export interface FeedbackState {
  open: boolean;
  draft: FeedbackDraft;
  status: "idle" | "sending" | "failed";
  failure: FeedbackFailure | null;
  requestId: string;
}

export interface FeedbackPrefill {
  kind?: FeedbackKind;
  text?: string;
}

interface StoreEnvironment {
  storage(): Storage | null;
  bridge(): FeedbackBridge | null;
  id(): string;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const BROWSER: StoreEnvironment = {
  storage: browserStorage,
  bridge: feedbackBridge,
  id: () => crypto.randomUUID(),
};

export function createFeedbackStore(env: StoreEnvironment = BROWSER) {
  let state: FeedbackState = {
    open: false,
    draft: readStoredDraft(env.storage()),
    status: "idle",
    failure: null,
    requestId: env.id(),
  };
  let errors: FeedbackRecentError[] = [];
  let opening = false;
  const listeners = new Set<() => void>();

  function set(next: FeedbackState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function update(patch: Partial<FeedbackDraft>): void {
    const draft = { ...state.draft, ...patch };
    writeStoredDraft(env.storage(), draft);
    set({ ...state, draft, status: "idle", failure: null, requestId: env.id() });
  }

  return {
    get: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    async open(prefill: FeedbackPrefill = {}): Promise<void> {
      if (opening) return;
      opening = true;
      try {
        if (prefill.kind || prefill.text)
          update({
            ...(prefill.kind ? { kind: prefill.kind } : {}),
            ...(prefill.text ? { text: mergePrefill(state.draft.text, prefill.text) } : {}),
          });
        const bridge = env.bridge();
        if (bridge && !state.open) {
          const consent = hasFeedbackDraft(state.draft)
            ? null
            : await within(bridge.diagnosticsConsent(), CAPTURE_TIMEOUT_MS, null);
          const png = await within(bridge.captureWindow(), CAPTURE_TIMEOUT_MS, null);
          set({
            ...state,
            draft: {
              ...state.draft,
              screenshot: png,
              screenshotIncluded: false,
              ...(consent === null ? {} : { diagnostics: consent }),
            },
          });
        }
        set({ ...state, open: true });
      } finally {
        opening = false;
      }
    },
    close(): void {
      if (state.status !== "sending") set({ ...state, open: false });
    },
    discard(): void {
      writeStoredDraft(env.storage(), newFeedbackDraft());
      set({
        open: false,
        draft: newFeedbackDraft(),
        status: "idle",
        failure: null,
        requestId: env.id(),
      });
    },
    sending(): void {
      set({ ...state, status: "sending", failure: null });
    },
    failed(failure: FeedbackFailure): void {
      set({ ...state, status: "failed", failure });
    },
    recordError(error: unknown, at: Date): void {
      errors = appendClientError(errors, { code: clientErrorCode(error), at: at.toISOString() });
    },
    errors: (): readonly FeedbackRecentError[] => errors,
    screenshotCapability: (): ScreenshotCapability | null => env.bridge()?.screenshot ?? null,
    onRequested(listener: () => void): () => void {
      return env.bridge()?.onFeedbackRequested(listener) ?? (() => {});
    },
  };
}

export type FeedbackStore = ReturnType<typeof createFeedbackStore>;

let shared: FeedbackStore | null = null;

export function feedbackStore(): FeedbackStore {
  shared ??= createFeedbackStore();
  return shared;
}

export function openFeedback(prefill?: FeedbackPrefill): void {
  void feedbackStore().open(prefill);
}

export function useFeedbackState(): FeedbackState {
  const store = feedbackStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
