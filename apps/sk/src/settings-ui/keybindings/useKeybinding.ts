// Hook that resolves the active keybinding map for a context. The
// component supplies a context name and a dispatch table; useKeybinding
// returns the per-keystroke matcher consumed inside `useInput`.

import type { Key } from "ink";

import { DEFAULT_BINDINGS } from "./default-bindings.ts";
import type { SettingsAction, SettingsContext } from "./schema.ts";

function patternFor(input: string, key: Key): string | null {
  if (key.escape) return "escape";
  if (key.return) return "return";
  if (key.tab && key.shift) return "shift+tab";
  if (key.tab) return "tab";
  if (key.upArrow) return "uparrow";
  if (key.downArrow) return "downarrow";
  if (key.leftArrow) return "leftarrow";
  if (key.rightArrow) return "rightarrow";
  if (key.ctrl && input.length === 1) return `ctrl+${input.toLowerCase()}`;
  if (input.length === 1 && !key.ctrl && !key.meta) return input;
  return null;
}

export function resolveAction(
  context: SettingsContext,
  input: string,
  key: Key,
): SettingsAction | null {
  const block = DEFAULT_BINDINGS.find((b) => b.context === context);
  if (!block) return null;
  const pattern = patternFor(input, key);
  if (!pattern) return null;
  const action = block.bindings[pattern];
  return action ?? null;
}
