// Validate that a slash name is a real command for the active persona.
//
// Centralizes the alias resolution + persona allow-list check so the
// SlashSuggest highlighting and the dispatcher both agree on the same
// answer. The legacy slash registry lives in `apps/sk/src/slash.ts`.

import type { PersonaProbe } from "../../slash.ts";
import { SLASH_COMMANDS, type SlashCommand } from "../../slash.ts";

/** Resolve a typed name (or alias) to the canonical command. */
export function resolveSlashCommand(name: string): SlashCommand | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return SLASH_COMMANDS.find(
    (c) => c.name === lower || (c.aliases?.some((a) => a === lower) ?? false),
  );
}

/** True when the name resolves to a command AND the persona is allowed
 *  to invoke it (or the command has no `requires` gate). */
export function hasCommand(name: string, persona: PersonaProbe): boolean {
  const cmd = resolveSlashCommand(name);
  if (!cmd) return false;
  if (!cmd.requires) return true;
  return persona.allows(cmd.requires);
}
