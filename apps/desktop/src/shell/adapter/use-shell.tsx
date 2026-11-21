import type { DropChoice } from "@shared/drop-choice.ts";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { ShellBridge, ShellState } from "../../shared/shell-ipc.ts";
import { type Translate, translator } from "../lib/text.ts";

export type ShellActions = Pick<ShellBridge, "sendNote" | "place" | "close" | "reopenBrowser">;

interface ShellContextValue {
  state: ShellState;
  actions: ShellActions;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({
  state,
  actions,
  children,
}: ShellContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

function useShellContext(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error("ShellProvider is missing");
  return value;
}

export function useShell() {
  const { state, actions } = useShellContext();
  return {
    s: {
      ui: {
        quick: state.view === "capture",
        dropSheet: state.view === "drop" ? state.drop : null,
        sheet: state.view === "sheet" ? state.sheet : null,
      },
      online: state.online,
      capture: state.capture,
    },
    a: {
      setUi: (patch: { quick?: boolean }) => {
        if (patch.quick === false) void actions.close();
      },
      quickNote: (text: string) => void actions.sendNote(text),
      closeDrop: () => void actions.close(),
      placeDrop: (choice: DropChoice) => void actions.place(choice),
      confirmSheet: () => void actions.reopenBrowser(),
      cancelSheet: () => void actions.close(),
    },
  };
}

export function useI18n(): { t: Translate; lang: ShellState["locale"]; platform: string } {
  const { state } = useShellContext();
  const t = useMemo(() => translator(state.messages), [state.messages]);
  return { t, lang: state.locale, platform: state.platform };
}
