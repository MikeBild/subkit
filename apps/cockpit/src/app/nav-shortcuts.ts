import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { runsInstalled } from "@/features/pwa";
import { desktopStatusBridgeOf } from "./desktop-status-model";
import { absolute } from "./links";
import { navShortcutTarget } from "./nav-shortcuts-model";

export interface NavShortcutWindow {
  appWindow: boolean;
  mac: boolean;
}

function readWindow(): NavShortcutWindow {
  if (typeof window === "undefined") return { appWindow: false, mac: false };
  const desktop =
    desktopStatusBridgeOf((window as unknown as { subkitDesktop?: unknown }).subkitDesktop) !==
    null;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  return { appWindow: desktop || runsInstalled(), mac: /mac/i.test(platform) };
}

export function useNavShortcuts(paths: readonly string[]): NavShortcutWindow {
  const router = useRouter();
  const shell = useMemo(readWindow, []);
  const current = useRef(paths);
  current.current = paths;
  useEffect(() => {
    if (!shell.appWindow) return;
    function onKeyDown(event: KeyboardEvent): void {
      const target = navShortcutTarget({
        event,
        mac: shell.mac,
        appWindow: shell.appWindow,
        paths: current.current,
      });
      if (!target) return;
      event.preventDefault();
      router.history.push(absolute(target));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, shell]);
  return shell;
}
