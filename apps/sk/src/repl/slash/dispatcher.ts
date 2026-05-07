// Slash-command dispatcher seam.
//
// Single source of truth for "is this slash a local action or does it
// route through the engine?". The REPL's input handler calls
// `classifySlash(name)` after `resolveSlashCommand` succeeds; the
// returned routing tag tells it whether to invoke a local handler or
// to mint a tool call.
//
// Routing is read off the `SlashCommand.routing` field in
// `apps/sk/src/slash.ts` — never inferred from the bare name. This
// closes a subtle loophole flagged in PR #145 (R1-S2 / R2-W4): if
// routing is decided by a hard-coded name list, a future slash command
// of the same name could silently bypass server-side RBAC + audit.
// Tagging at registration removes that class of bug.
//
// Default for any command without an explicit `routing` is `"engine"`
// — i.e. forward to the engine so RBAC + audit run on the same path
// the LLM tool-call would. Local-only is opt-in.

import { SLASH_COMMANDS, type SlashCommand } from "../../slash.ts";
import { resolveSlashCommand } from "./hasCommand.ts";

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
  return { routing: cmd.routing ?? "engine", command: cmd };
}

/** Test-only: snapshot of the local-only set, derived from the
 *  registry. Used by the dispatcher tests so accidental additions
 *  surface in PR review. */
export function _localOnlySnapshot(): readonly string[] {
  return SLASH_COMMANDS.filter((c) => c.routing === "local").map((c) => c.name);
}
