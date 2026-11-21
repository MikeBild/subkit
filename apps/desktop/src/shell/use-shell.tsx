import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { DropChoice } from "../shared/drop-model.ts";
import type { ShellBridge, ShellState } from "../shared/shell-ipc.ts";
import { type ShellDict, shellDict } from "./shell-dict.ts";

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

export function useI18n(): { t: ShellDict; lang: ShellState["locale"] } {
  const { state } = useShellContext();
  const t = useMemo(
    () => shellDict(state.messages, state.platform),
    [state.messages, state.platform],
  );
  return { t, lang: state.locale };
}
