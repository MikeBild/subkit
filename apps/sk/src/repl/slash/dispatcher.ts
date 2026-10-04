import { SLASH_COMMANDS, type SlashCommand } from "../../slash.ts";
import { resolveSlashCommand } from "./hasCommand.ts";

export type SlashRouting = "local" | "engine" | "unknown";

export interface SlashDispatchPlan {
  routing: SlashRouting;
  command: SlashCommand | undefined;
}

export { INK_INTERCEPTED_LOCAL_SLASHES } from "../../slash.ts";

export function classifySlash(name: string): SlashDispatchPlan {
  const cmd = resolveSlashCommand(name);
  if (!cmd) return { routing: "unknown", command: undefined };
  return { routing: cmd.routing ?? "engine", command: cmd };
}

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

export function _localOnlySnapshot(): readonly string[] {
  return SLASH_COMMANDS.filter((c) => c.routing === "local").map((c) => c.name);
}
