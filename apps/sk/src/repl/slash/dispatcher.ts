// Slash-command dispatcher seam.
//
// Single source of truth for "is this slash a local action or does it
// route through the engine?". The REPL's input handler calls
// `classifySlash(name)` after `resolveSlashCommand` succeeds; the
// returned routing tag tells it whether to invoke a local handler or
// to mint a tool call.
//
// Local-only slashes are limited to operations that touch only the
// CLI's own session state (no engine effect, no audit row): /clear,
// /help, /cost, /verbose, /debug. Everything else goes through the
// engine so RBAC + audit run on the same path the LLM tool-call would.

import type { SlashCommand } from "../../slash.ts";
import { resolveSlashCommand } from "./hasCommand.ts";

const LOCAL_ONLY_NAMES: readonly string[] = [
  "help",
  "clear",
  "cost",
  "verbose",
  "debug",
  "exit",
  "quit",
  "status",
  "memory",
  "history",
  "actions",
  "themes",
  "theme",
];

export type SlashRouting = "local" | "engine" | "unknown";

export interface SlashDispatchPlan {
  routing: SlashRouting;
  command: SlashCommand | undefined;
}

/**
 * Decide where to route a slash invocation. `local` slashes apply
 * client-side (no audit, no network); `engine` slashes are forwarded
 * to the engine (typically as a tool call); `unknown` means the name
 * doesn't resolve to any registered command.
 */
export function classifySlash(name: string): SlashDispatchPlan {
  const cmd = resolveSlashCommand(name);
  if (!cmd) return { routing: "unknown", command: undefined };
  if (LOCAL_ONLY_NAMES.includes(cmd.name)) return { routing: "local", command: cmd };
  return { routing: "engine", command: cmd };
}

/** Test-only: snapshot of the local-only set (asserted by the
 *  dispatcher tests so accidental additions surface in PR review). */
export function _localOnlySnapshot(): readonly string[] {
  return LOCAL_ONLY_NAMES.slice();
}
