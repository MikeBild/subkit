import { errorCatalog } from "@shared/error-catalog.ts";
import { UiProvider } from "@ui/lib/ui-context";
import { Workflow } from "lucide-react";
import { useMemo } from "react";
import type { LiveWindowState } from "../../shared/live-ipc.ts";
import type { LiveActions } from "../adapter/index.ts";
import { LiveView, OverlayPill } from "../features/live-view/index.ts";
import { translator } from "../lib/text.ts";

export function LiveWindow({ state, actions }: { state: LiveWindowState; actions: LiveActions }) {
  const t = useMemo(() => translator(state.messages), [state.messages]);
  return (
    <UiProvider
      lang={state.locale}
      mark={Workflow}
      appName="SubKit"
      errors={errorCatalog(state.locale)}
    >
      {state.view === "overlay" ? (
        <OverlayPill live={state.live} t={t} actions={actions} />
      ) : (
        <LiveView live={state.live} t={t} actions={actions} />
      )}
    </UiProvider>
  );
}
