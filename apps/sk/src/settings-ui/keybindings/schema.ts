// Keybinding registry — Zod-validated, context-scoped action map.
//
// Every action has a stable string id;
// every binding maps a keystroke pattern to one action id (or to null
// to unbind a default). Each input context owns its own binding map so
// the same keystroke can mean different things in different modes
// (e.g. Esc closes the modal in Settings but only clears the search
// query in Search).

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

export const KeyPatternSchema = z.string().min(1);

const ContextEnumSchema = z.enum(SETTINGS_CONTEXTS);
const ActionEnumSchema = z.enum(SETTINGS_ACTIONS).nullable();

export const KeybindingMapSchema = z
  .record(KeyPatternSchema, ActionEnumSchema)
  .describe("Keystroke pattern → action id (or null to unbind a default)");

export const KeybindingBlockSchema = z.object({
  context: ContextEnumSchema,
  bindings: KeybindingMapSchema,
});

export type KeybindingBlock = z.infer<typeof KeybindingBlockSchema>;
