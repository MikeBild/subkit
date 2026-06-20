// Reusable PTY step-builders for REPL scenarios.
//
// Thin, composable wrappers over the `ExpectStep` union in `pty.ts` so REPL
// tests read as intent ("wait for the quick-start banner, send /help, exit")
// rather than raw TCL-regex literals. These target the STABLE REPL surface:
// the quick-start banner the Ink REPL always renders on boot, slash-command
// output, and a clean `/exit`. (The starter-action LLM flows are gated
// behind SK_RUN_STARTER_E2E because they need mock scripts that aren't
// seeded — see sk-interactive-smoke.e2e.test.ts.)

import type { ExpectStep } from "./pty.ts";

/** The banner the Ink REPL prints once it has booted + authed. */
export const QUICK_START_PATTERN = "Resume work, create a connector";

/** Wait until the REPL has fully booted (quick-start banner visible). */
export function quickStartReady(): ExpectStep {
  return { kind: "wait", pattern: QUICK_START_PATTERN, label: "quick-start" };
}

/** Wait for an arbitrary regex to appear in the REPL output. */
export function expectVisible(pattern: string, label?: string): ExpectStep {
  return { kind: "wait", pattern, ...(label ? { label } : {}) };
}

/** Send a raw key/number with no newline (menu selection). */
export function sendKey(text: string): ExpectStep {
  return { kind: "send", text };
}

/** Send a line of input (appends carriage return). */
export function sendLine(text: string): ExpectStep {
  return { kind: "send", text: `${text}\r` };
}

/** Type a slash command and submit it. */
export function slash(command: string): ExpectStep {
  return sendLine(command.startsWith("/") ? command : `/${command}`);
}

/** Cleanly leave the REPL. */
export function exit(): ExpectStep {
  return sendLine("/exit");
}
