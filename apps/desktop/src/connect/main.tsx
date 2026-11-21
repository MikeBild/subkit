import { createRoot } from "react-dom/client";
import type { ConnectBridge } from "../shared/ipc.ts";
import { createLocalCapabilities, createSignInStore } from "./adapter/index.ts";
import { SignInWindow } from "./pages/index.ts";

declare global {
  interface Window {
    subkitConnect: ConnectBridge;
  }
}

function followSystemTheme(): void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", query.matches);
  apply();
  query.addEventListener("change", apply);
}

followSystemTheme();
const root = document.getElementById("root");
if (!root) throw new Error("The sign-in window has no root element");
createRoot(root).render(
  <SignInWindow
    store={createSignInStore(window.subkitConnect)}
    local={createLocalCapabilities(window.subkitConnect)}
  />,
);
