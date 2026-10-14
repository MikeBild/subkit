import { useEffect, useRef, useState } from "react";

const CONTEXT_PREFERENCE = "sk-cockpit-chat-context";
export const CHAT_CONTEXT_MIN_TRANSCRIPT_WIDTH = 680;
export const CHAT_CONTEXT_MIN_DOCK_WIDTH = 320;
export const CHAT_CONTEXT_MAX_DOCK_WIDTH = 640;
export const CHAT_CONVERSATION_LIST_WIDTH = 264;
export const CHAT_CONVERSATION_LIST_MIN_WORKSPACE_WIDTH =
  CHAT_CONVERSATION_LIST_WIDTH + CHAT_CONTEXT_MIN_TRANSCRIPT_WIDTH;
type ScopedChatContextPreference = "narrow-open" | "narrow-closed" | "wide-open" | "wide-closed";
export type ChatContextPreference = ScopedChatContextPreference | "legacy-open" | null;

export function chatContextDockWidth(availableWidth: number): number {
  return Math.min(
    CHAT_CONTEXT_MAX_DOCK_WIDTH,
    Math.max(CHAT_CONTEXT_MIN_DOCK_WIDTH, Math.round(availableWidth * 0.34)),
  );
}

export function chatAvailableWidth(
  workspaceWidth: number,
  conversationListWidth: number,
  horizontal: boolean,
): number {
  return Math.max(0, workspaceWidth - (horizontal ? conversationListWidth : 0));
}

export function chatConversationListDocked(workspaceWidth: number): boolean {
  return workspaceWidth >= CHAT_CONVERSATION_LIST_MIN_WORKSPACE_WIDTH;
}

function dockedAtWidth(availableWidth: number): boolean {
  return availableWidth - chatContextDockWidth(availableWidth) >= CHAT_CONTEXT_MIN_TRANSCRIPT_WIDTH;
}

export function chatContextControlsTarget(
  open: boolean,
  hasConversation: boolean,
): string | undefined {
  return open && hasConversation ? "chat-context-content" : undefined;
}

export function storedChatContextPreference(value: string | null): ChatContextPreference {
  if (value === "open") return "legacy-open";
  if (value === "closed") return "narrow-closed";
  if (
    value === "narrow-open" ||
    value === "narrow-closed" ||
    value === "wide-open" ||
    value === "wide-closed"
  )
    return value;
  return null;
}

export function chatContextPreference(open: boolean, width: number): ScopedChatContextPreference {
  const layout = dockedAtWidth(width) ? "wide" : "narrow";
  return `${layout}-${open ? "open" : "closed"}`;
}

export function chatContextState(
  availableWidth: number,
  preference: ChatContextPreference,
  hasConversation: boolean,
) {
  const dockWidth = chatContextDockWidth(availableWidth);
  const docked = dockedAtWidth(availableWidth);
  const preferenceMatchesWidth =
    preference === "legacy-open" ||
    (docked ? preference?.startsWith("wide-") : preference?.startsWith("narrow-")) === true;
  return {
    docked,
    dockWidth,
    open:
      hasConversation &&
      (preferenceMatchesWidth
        ? preference === "legacy-open" || preference === (docked ? "wide-open" : "narrow-open")
        : docked),
  };
}

export function useChatWorkspace(hasConversation: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const horizontal = chatConversationListDocked(workspaceWidth);
  const [preference, setPreference] = useState<ChatContextPreference>(() => {
    try {
      const saved = window.localStorage.getItem(CONTEXT_PREFERENCE);
      return storedChatContextPreference(saved);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const list = element.querySelector<HTMLElement>('[data-testid="chat-list-panel"]');
      const nextWorkspaceWidth = element.clientWidth;
      setWorkspaceWidth(nextWorkspaceWidth);
      const isHorizontal =
        element.ownerDocument.defaultView?.getComputedStyle(element).flexDirection === "row";
      setWidth(
        chatAvailableWidth(
          nextWorkspaceWidth,
          list?.getBoundingClientRect().width ?? 0,
          isHorizontal,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const list = element.querySelector<HTMLElement>('[data-testid="chat-list-panel"]');
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [horizontal]);
  const setOpen = (open: boolean) => {
    const next = chatContextPreference(open, width);
    setPreference(next);
    try {
      if (next) window.localStorage.setItem(CONTEXT_PREFERENCE, next);
    } catch {}
  };
  return {
    ref,
    horizontal,
    ...chatContextState(width, preference, hasConversation),
    setOpen,
  };
}
