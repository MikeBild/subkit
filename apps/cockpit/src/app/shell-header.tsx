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

export const CHAT_COLUMN = "mx-auto w-full min-w-0 max-w-[80rem]";

export type TriggerOwner = "bar" | "page";

export function triggerOwner(input: {
  mobile: boolean;
  chatHeader: boolean;
  pageFrames: number;
}): TriggerOwner {
  if (input.mobile || input.chatHeader || input.pageFrames === 0) return "bar";
  return "page";
}

interface ShellHeaderValue {
  owner: TriggerOwner;
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

export function usePageFrameTrigger(): boolean {
  const { owner, claimPageFrame } = useContext(ShellHeaderContext);
  useLayoutEffect(() => claimPageFrame(), [claimPageFrame]);
  return owner === "page";
}

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

export function useChatHeaderSlot(): HTMLElement | null {
  const { slot, claimChatHeader } = useContext(ShellHeaderContext);
  useLayoutEffect(() => claimChatHeader(), [claimChatHeader]);
  return slot;
}
