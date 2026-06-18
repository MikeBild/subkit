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
 * One-release guidance for slashes that have been removed from the
 * registry (or that callers occasionally try to use because they
 * exist in another tool). Returns the guidance line when the bare
 * name matches; null otherwise.
 *
 * The guidance map covers two cohorts:
 *
 *  1. **Removed in the consolidation pass** — slashes that pre-M13 had
 *     a registered command but were collapsed into a hub (e.g. `/health`
 *     → `/audit`, `/install-slack` → `/install`). Once one minor
 *     release has shipped with the guidance, the entries are deleted —
 *     per repo memory rule "no backwards-compat shims".
 *
 *  2. **Agentic-coding slashes that intentionally don't exist in sk**
 *     (`/agents`, `/fast`, `/plan`, `/diff`, `/output-style`,
 *     `/rewind`). These never had a registration; the guidance is
 *     permanent because the question keeps coming up.
 */
export const REMOVED_SLASH_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  // G11 cohort — actually removed in the M13 destructive pass.
  "install-slack": "moved into `/install`",
  "install-teams": "moved into `/install`",
  "install-github": "moved into `/install`",
  "install-google-workspace": "moved into `/install`",
  "install-salesforce": "moved into `/install`",
  "install-jira": "moved into `/install`",
  "install-hubspot": "moved into `/install`",
  // Agentic-coding slashes that subkit intentionally does NOT ship.
  // Permanent guidance — these were never registered.
  agents:
    "subkit has no subagent routing — Skills, Knowledge Sources, and Connectors fill those niches; see `/skills` and `/knowledge`",
  fast: "subkit uses a single configured model — see `model` setting via `/model`",
  plan: "agentic-coding pattern; subkit's analogue is `/draft` for connector + workflow YAML",
  diff: "subkit does not edit user code; patch-candidate diffs render inside `/approvals`",
  "output-style":
    "subkit output is conversational, not code-generative; theme + status line are in `/settings → Config`",
  rewind:
    "term collides with `workflows restore`; conversation rewind is `/resume → press t` (M10)",
});

export function removedSlashGuidance(name: string): string | null {
  const hint = REMOVED_SLASH_GUIDANCE[name];
  return hint ?? null;
}

/** Test-only: snapshot of the local-only set, derived from the
 *  registry. Used by the dispatcher tests so accidental additions
 *  surface in PR review. */
export function _localOnlySnapshot(): readonly string[] {
  return SLASH_COMMANDS.filter((c) => c.routing === "local").map((c) => c.name);
}
