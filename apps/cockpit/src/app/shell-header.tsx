import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n-context";

// Who draws the sidebar toggle, and whether the shell's top bar is there at all.
//
// The bar used to stand on every page holding one icon: 48px of empty band
// above a page header that already names the page. It stays where it carries
// something — a phone (the navigation is an offcanvas sheet opened from it), a
// record's breadcrumb, the chat's own header — and a page frame that has
// claimed the toggle puts it beside its heading instead.
//
// Exactly ONE toggle exists in the document at a time, never two copies hidden
// by CSS: the sweeps click `sidebar-trigger` by test id, and a second element,
// visible or not, is a second match. The owner is decided in one place, here.

/** The column chat's header, transcript and composer share. */
export const CHAT_COLUMN = "mx-auto w-full max-w-[1280px]";

export type TriggerOwner = "bar" | "page";

/**
 * Where the toggle belongs. The bar owns it unless a page frame has claimed it
 * on a wide screen with nothing else in the bar.
 */
export function triggerOwner(input: {
  mobile: boolean;
  breadcrumb: boolean;
  chatHeader: boolean;
  pageFrames: number;
}): TriggerOwner {
  if (input.mobile || input.breadcrumb || input.chatHeader || input.pageFrames === 0) return "bar";
  return "page";
}

interface ShellHeaderValue {
  owner: TriggerOwner;
  /** The element the chat header portals into; null until the bar mounts it. */
  slot: HTMLElement | null;
  claimPageFrame(): () => void;
  claimChatHeader(): () => void;
}

const ShellHeaderContext = createContext<ShellHeaderValue>({
  owner: "bar",
  slot: null,
  claimPageFrame: () => () => {},
  claimChatHeader: () => () => {},
});

/** Counters, not booleans: a page swap mounts the next frame before the last unmounts. */
export function useShellHeaderState(): {
  pageFrames: number;
  chatHeaders: number;
  slot: HTMLElement | null;
  setSlot(node: HTMLElement | null): void;
  claimPageFrame(): () => void;
  claimChatHeader(): () => void;
} {
  const [pageFrames, setPageFrames] = useState(0);
  const [chatHeaders, setChatHeaders] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const claimPageFrame = useCallback(() => {
    setPageFrames((count) => count + 1);
    return () => setPageFrames((count) => count - 1);
  }, []);
  const claimChatHeader = useCallback(() => {
    setChatHeaders((count) => count + 1);
    return () => setChatHeaders((count) => count - 1);
  }, []);
  return { pageFrames, chatHeaders, slot, setSlot, claimPageFrame, claimChatHeader };
}

export function ShellHeaderProvider({
  owner,
  slot,
  claimPageFrame,
  claimChatHeader,
  children,
}: ShellHeaderValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ owner, slot, claimPageFrame, claimChatHeader }),
    [owner, slot, claimPageFrame, claimChatHeader],
  );
  return <ShellHeaderContext.Provider value={value}>{children}</ShellHeaderContext.Provider>;
}

/**
 * A page frame claims the toggle; true when it should draw it. Claimed in a
 * layout effect so a wide screen never paints one frame of the bar first.
 */
export function usePageFrameTrigger(): boolean {
  const { owner, claimPageFrame } = useContext(ShellHeaderContext);
  useLayoutEffect(() => claimPageFrame(), [claimPageFrame]);
  return owner === "page";
}

/** The one sidebar toggle, wherever its owner draws it. */
export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <SidebarTrigger
      className={className}
      label={t("nav.toggle")}
      aria-label={t("nav.toggle")}
      data-testid="sidebar-trigger"
    />
  );
}

/** The chat claims the bar for its header and receives the element to portal into. */
export function useChatHeaderSlot(): HTMLElement | null {
  const { slot, claimChatHeader } = useContext(ShellHeaderContext);
  useLayoutEffect(() => claimChatHeader(), [claimChatHeader]);
  return slot;
}
