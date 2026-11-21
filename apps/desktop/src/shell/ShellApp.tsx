import { UiProvider } from "@ui/lib/ui-context";
import { useEffect } from "react";
import type { ShellState } from "../shared/shell-ipc.ts";
import { BrowserSheet } from "./BrowserSheet.tsx";
import { DropSheet } from "./DropSheet.tsx";
import { QuickCapture } from "./QuickCapture.tsx";
import { type ShellActions, ShellProvider } from "./use-shell.tsx";

export type { ShellActions } from "./use-shell.tsx";

export function ShellApp({ state, actions }: { state: ShellState; actions: ShellActions }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.view === "sheet") void actions.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.view, actions]);
  return (
    <UiProvider lang={state.locale}>
      <ShellProvider state={state} actions={actions}>
        <QuickCapture />
        <DropSheet />
        <BrowserSheet />
      </ShellProvider>
    </UiProvider>
  );
}
