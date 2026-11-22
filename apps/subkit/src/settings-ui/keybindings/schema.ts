import { z } from "zod";

export const SETTINGS_CONTEXTS = ["Settings", "Search", "Confirm", "Field"] as const;
export type SettingsContext = (typeof SETTINGS_CONTEXTS)[number];

export const SETTINGS_ACTIONS = [
  "list:next",
  "list:prev",
  "list:edit",
  "search:focus",
  "search:clear",
  "field:reveal-secret",
  "field:commit",
  "field:cancel",
  "confirm:yes",
  "confirm:no",
] as const;
export type SettingsAction = (typeof SETTINGS_ACTIONS)[number];

const KeyPatternSchema = z.string().min(1);

const ContextEnumSchema = z.enum(SETTINGS_CONTEXTS);
const ActionEnumSchema = z.enum(SETTINGS_ACTIONS).nullable();

const KeybindingMapSchema = z
  .record(KeyPatternSchema, ActionEnumSchema)
  .describe("Keystroke pattern → action id (or null to unbind a default)");

export const KeybindingBlockSchema = z.object({
  context: ContextEnumSchema,
  bindings: KeybindingMapSchema,
});

export type KeybindingBlock = z.infer<typeof KeybindingBlockSchema>;
