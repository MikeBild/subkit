// Transient notice-strip state for the Ink REPL.
//
// Owns the NoticeStack item list (info/warning/error strips above the
// transcript), their auto-expiry, and the structured-error path that
// mirrors engine failures into both the legacy strip and the richer
// ErrorPanel toast.

import type { PendingElicitation } from "@cli-core/index.ts";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { humanizeRequestError } from "../repl/error-humanize.ts";
import { bodyOf, errorToPanel } from "../shell/ErrorPanel.tsx";
import type { NoticeItem, NoticeTone } from "../shell/NoticeStack.tsx";
import { type ToastInput, useToast } from "../shell/ToastQueue.tsx";
import { PENDING_NOTICE_PREFIX, pendingNoticeMessage } from "./elicit-transcript.ts";

export interface TranscriptNotice extends NoticeItem {
  expires_at?: number | undefined;
}

export interface NoticesApi {
  notices: TranscriptNotice[];
  setNotices: React.Dispatch<React.SetStateAction<TranscriptNotice[]>>;
  pushNotice: (tone: NoticeTone, message: string, persistent?: boolean) => void;
  dismissNotice: () => void;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
  showStructuredError: (err: unknown, slashName?: string) => void;
}

export function useNotices(): NoticesApi {
  const [notices, setNotices] = useState<TranscriptNotice[]>([]);
  const pushNotice = useCallback((tone: NoticeTone, message: string, persistent = false) => {
    setNotices((current) => {
      const next: TranscriptNotice = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        tone,
        message,
        persistent,
        ...(persistent ? {} : { expires_at: Date.now() + 4500 }),
      };
      return [next, ...current.filter((item) => item.message !== message)].slice(0, 4);
    });
  }, []);
  const dismissNotice = useCallback(() => {
    setNotices((current) => {
      const idx = current.findIndex((item) => item.persistent);
      if (idx < 0) return current;
      return current.filter((_item, itemIdx) => itemIdx !== idx);
    });
  }, []);
  const showInfo = useCallback(
    (message: string) => {
      pushNotice("info", message);
    },
    [pushNotice],
  );
  // Kept around for future warning notices (e.g. yolo expiry, queue
  // overflow). The setup-validation banner that previously used this
  // moved to a sticky row above the welcome panel — see SetupBanner.
  const _showWarning = useCallback(
    (message: string, persistent = true) => {
      pushNotice("warning", message, persistent);
    },
    [pushNotice],
  );
  void _showWarning;
  const toast = useToast();
  const showError = useCallback(
    (message: string) => {
      pushNotice("error", message, true);
    },
    [pushNotice],
  );
  /**
   * Structured-error path: pushes the humanized headline through the
   * legacy notice strip AND surfaces the new ErrorPanel via the
   * ToastQueue. Both render — the toast carries the rich envelope
   * (status, code, hint, retry_after countdown) the legacy strip can't.
   */
  const showStructuredError = useCallback(
    (err: unknown, slashName?: string) => {
      const headline = humanizeRequestError(err);
      pushNotice("error", slashName ? `/${slashName}: ${headline}` : headline, true);
      try {
        const panel = errorToPanel(err);
        const titleByKind: Record<string, string> = {
          "rate-limit": "rate limit",
          validation: "validation error",
          network: "network error",
          engine: "engine error",
          auth: "auth error",
          generic: "error",
        };
        const t: ToastInput = {
          id: `err-${slashName ?? "engine"}-${Date.now().toString(36)}`,
          level: panel.kind === "rate-limit" || panel.kind === "network" ? "warn" : "error",
          title: titleByKind[panel.kind] ?? "error",
          // bodyOf() narrows the discriminated union once and returns
          // a string — no double `as`-cast leaks across the boundary.
          body: bodyOf(panel) ?? headline,
          ttlMs: 8000,
        };
        toast.push(t);
      } catch {
        // Toast is best-effort; legacy notice always fires above.
      }
    },
    [pushNotice, toast],
  );

  useEffect(() => {
    const id = setInterval(() => {
      setNotices((current) => {
        const now = Date.now();
        return current.filter((item) => item.persistent || (item.expires_at ?? 0) > now);
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  return {
    notices,
    setNotices,
    pushNotice,
    dismissNotice,
    showInfo,
    showError,
    showStructuredError,
  };
}

/**
 * Keeps the "Waiting for input" fallback notice in lockstep with the
 * pending elicitation, and mirrors the pending flag into the ref the
 * queue drains consult (their `session` closure is stale by design).
 */
export function usePendingElicitationNotice(
  pendingElicitation: PendingElicitation | null,
  pendingElicitationRef: React.MutableRefObject<boolean>,
  setNotices: React.Dispatch<React.SetStateAction<TranscriptNotice[]>>,
): void {
  useEffect(() => {
    // Keep the drain-side ref in lockstep with session state.
    pendingElicitationRef.current = pendingElicitation !== null;
    const message = pendingElicitation ? pendingNoticeMessage(pendingElicitation) : null;
    setNotices((current) => {
      const withoutPending = current.filter(
        (item) => !item.message.startsWith(PENDING_NOTICE_PREFIX),
      );
      if (!message) {
        return withoutPending.length === current.length ? current : withoutPending;
      }
      const existing = current.find((item) => item.persistent && item.message === message);
      if (existing && withoutPending.length === current.length - 1) {
        return current;
      }
      return [
        {
          id: `pending-${pendingElicitation?.id ?? "unknown"}`,
          tone: "warning" as const,
          message,
          persistent: true,
        },
        ...withoutPending,
      ].slice(0, 4);
    });
  }, [pendingElicitation, pendingElicitationRef, setNotices]);
}
