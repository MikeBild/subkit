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
          body: bodyOf(panel) ?? headline,
          ttlMs: 8000,
        };
        toast.push(t);
      } catch {}
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

export function usePendingElicitationNotice(
  pendingElicitation: PendingElicitation | null,
  pendingElicitationRef: React.MutableRefObject<boolean>,
  setNotices: React.Dispatch<React.SetStateAction<TranscriptNotice[]>>,
): void {
  useEffect(() => {
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
