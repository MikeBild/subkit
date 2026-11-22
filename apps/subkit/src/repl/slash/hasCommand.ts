import type { PersonaProbe } from "../../slash.ts";
import { SLASH_COMMANDS, type SlashCommand } from "../../slash.ts";

export function resolveSlashCommand(name: string): SlashCommand | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return SLASH_COMMANDS.find(
    (c) => c.name === lower || (c.aliases?.some((a) => a === lower) ?? false),
  );
}

export function hasCommand(name: string, persona: PersonaProbe): boolean {
  const cmd = resolveSlashCommand(name);
  if (!cmd) return false;
  if (!cmd.requires) return true;
  return persona.allows(cmd.requires);
}
