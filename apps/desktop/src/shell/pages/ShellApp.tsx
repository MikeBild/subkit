import { errorCatalog } from "@shared/error-catalog.ts";
import { UiProvider } from "@ui/lib/ui-context";
import { Workflow } from "lucide-react";
import { useEffect } from "react";
import type { ShellState } from "../../shared/shell-ipc.ts";
import { type ShellActions, ShellProvider } from "../adapter/use-shell.tsx";
import { BrowserSheet } from "../features/browser/index.ts";
import { QuickCapture } from "../features/capture/index.ts";
import { DropSheet } from "../features/drop/index.ts";

export function ShellApp({ state, actions }: { state: ShellState; actions: ShellActions }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.view === "sheet") void actions.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.view, actions]);
  return (
    <UiProvider
      lang={state.locale}
      mark={Workflow}
      appName="SubKit"
      errors={errorCatalog(state.locale)}
    >
      <ShellProvider state={state} actions={actions}>
        <QuickCapture />
        <DropSheet />
        <BrowserSheet />
      </ShellProvider>
    </UiProvider>
  );
}
