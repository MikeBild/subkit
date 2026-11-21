import { createRoot } from "react-dom/client";
import type { LiveBridge, LiveWindowState } from "../shared/live-ipc.ts";
import { liveActions, watchLive } from "./adapter/index.ts";
import { LiveWindow } from "./pages/index.ts";

declare global {
  interface Window {
    subkitLive?: LiveBridge;
  }
}

function start(): void {
  const bridge = window.subkitLive;
  const container = document.getElementById("root");
  if (!bridge || !container) return;
  const root = createRoot(container);
  const actions = liveActions(bridge);
  watchLive(bridge, (state: LiveWindowState) => {
    document.documentElement.lang = state.locale;
    document.documentElement.classList.toggle("dark", state.dark);
    document.documentElement.classList.toggle("overlay", state.view === "overlay");
    root.render(<LiveWindow state={state} actions={actions} />);
  });
}

start();
