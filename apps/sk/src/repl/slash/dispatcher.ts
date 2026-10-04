// Slash-command dispatcher seam.
//
// Single source of truth for "is this slash a local action or does it
// route through the engine?". The REPL's input handler calls
// `classifySlash(name)` after `resolveSlashCommand` succeeds; the
// returned routing tag tells it whether to invoke a local handler or
// to mint a tool call.
//
// Routing is read off the `SlashCommand.routing` field in
// `apps/sk/src/slash.ts` — never inferred from the bare name. If
// routing were decided by a hard-coded name list, a future slash
// command of the same name could silently bypass server-side RBAC +
// audit. Tagging at registration removes that class of bug.
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

// `INK_INTERCEPTED_LOCAL_SLASHES` moved to
// `apps/sk/src/slash.ts` (next to `SLASH_COMMANDS`) because it's
// metadata about the registry, not about dispatch. Re-exported
// here for the dispatcher contract test that imports from this
// file (`apps/sk/src/tests/slash-dispatcher.test.ts`).
export { INK_INTERCEPTED_LOCAL_SLASHES } from "../../slash.ts";

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

/**
 * Guidance for agentic-coding slashes that sk intentionally does not
 * ship (`/agents`, `/fast`, `/plan`, `/diff`, `/output-style`,
 * `/rewind`). They were never registered; the question keeps coming
 * up, so the bare name answers with where the need is met instead.
 */
export const UNSUPPORTED_SLASH_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  agents:
    "subkit has no subagent routing — Skills, Knowledge Sources, and Connectors fill those niches; see `/skills` and `/knowledge`",
  fast: "subkit uses a single configured model — see `model` setting via `/model`",
  plan: "agentic-coding pattern; subkit's analogue is `/draft` for connector + workflow YAML",
  diff: "subkit does not edit user code; patch-candidate diffs render inside `/approvals`",
  "output-style":
    "subkit output is conversational, not code-generative; theme + status line are in `/settings → Config`",
  rewind: "term collides with `workflows restore`; conversation rewind is `/resume → press t`",
});

export function unsupportedSlashGuidance(name: string): string | null {
  const hint = UNSUPPORTED_SLASH_GUIDANCE[name];
  return hint ?? null;
}

/** Test-only: snapshot of the local-only set, derived from the
 *  registry. Used by the dispatcher tests so accidental additions
 *  are caught. */
export function _localOnlySnapshot(): readonly string[] {
  return SLASH_COMMANDS.filter((c) => c.routing === "local").map((c) => c.name);
}
