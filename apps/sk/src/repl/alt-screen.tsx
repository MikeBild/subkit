// Alternate-screen-buffer wrapper. Emits the DECSET 1049 sequence
// on mount (which clears the visible area, preserves the caller's
// scrollback, and hides the cursor until unmount) and the
// corresponding reset on unmount. Used by the REPL to toggle a
// transcript view that doesn't bleed into the user's shell
// history when they `/exit`.
//
// Rendering is a pass-through — this component is purely a side
// effect on mount / unmount, same as Claude Code's AlternateScreen.

import type React from "react";
import { useEffect } from "react";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface AlternateScreenProps {
  enabled: boolean;
  children: React.ReactNode;
}

function resolveAltScreenEnabled(): boolean {
  const mode = (process.env.SK_ALT_SCREEN ?? "auto").toLowerCase();
  if (mode === "never") return false;
  if (mode === "always") return true;
  // Zellij intentionally drops scrollback in alternate-screen mode.
  if (process.env.ZELLIJ) return false;
  return true;
}

export const AlternateScreen: React.FC<AlternateScreenProps> = ({ enabled, children }) => {
  useEffect(() => {
    if (!enabled) return;
    if (!process.stdout.isTTY) return;
    if (!resolveAltScreenEnabled()) return;
    process.stdout.write(ENTER_ALT_SCREEN);
    process.stdout.write(HIDE_CURSOR);
    return () => {
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write(EXIT_ALT_SCREEN);
    };
  }, [enabled]);
  return <>{children}</>;
};
