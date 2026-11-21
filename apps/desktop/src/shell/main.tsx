import { createRoot } from "react-dom/client";
import type { ShellBridge, ShellState } from "../shared/shell-ipc.ts";
import { ShellApp } from "./pages/ShellApp.tsx";

declare global {
  interface Window {
    subkitShell?: ShellBridge;
  }
}

function render(bridge: ShellBridge, state: ShellState, root: ReturnType<typeof createRoot>) {
  document.documentElement.lang = state.locale;
  document.documentElement.classList.toggle("dark", state.dark);
  root.render(<ShellApp state={state} actions={bridge} />);
}

async function start(): Promise<void> {
  const bridge = window.subkitShell;
  const container = document.getElementById("root");
  if (!bridge || !container) return;
  const root = createRoot(container);
  bridge.onState((state) => render(bridge, state, root));
  const state = await bridge.getState();
  if (state) render(bridge, state, root);
}

void start();
