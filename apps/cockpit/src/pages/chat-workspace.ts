import { useEffect, useRef, useState } from "react";

const CONTEXT_PREFERENCE = "sk-cockpit-chat-context";
export type ChatContextPreference = "open" | "closed" | null;

export function chatContextState(
  width: number,
  preference: ChatContextPreference,
  hasConversation: boolean,
) {
  const docked = width >= 1200;
  return {
    docked,
    open: preference === "open" || (preference === null && docked && hasConversation),
  };
}

export function useChatWorkspace(hasConversation: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preference, setPreference] = useState<ChatContextPreference>(() => {
    try {
      const saved = window.localStorage.getItem(CONTEXT_PREFERENCE);
      return saved === "open" || saved === "closed" ? saved : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const setOpen = (open: boolean) => {
    const next = open ? "open" : "closed";
    setPreference(next);
    try {
      window.localStorage.setItem(CONTEXT_PREFERENCE, next);
    } catch {}
  };
  return { ref, ...chatContextState(width, preference, hasConversation), setOpen };
}
