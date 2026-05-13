// Default keybindings for the settings-ui surfaces.
//
// Operator overrides are not yet wired in — the loader call site
// pulls from this map directly. When we add `~/.sk/keybindings.json`
// (mirroring claude-code's pattern), `useKeybinding` will merge the
// operator's overlay over these defaults the same way claude-code's
// `loadBindings` does.
//
// Only contexts that have a live consumer are listed — `resolveAction`
// is called from ConfigTab + SkillsTab (Settings, Search), FieldEditor
// (Field), and ConfirmModal (Confirm). The outer SettingsModal handles
// Esc / arrow / `[` / `]` directly via `useInput`, so there is no
// `settings:tab-next` / `settings:close` binding here. Operator surfaces
// (`/permissions`, `/profile`, `/admin`) use the SinglePane shell for
// Esc — also not via `resolveAction`.

import type { KeybindingBlock } from "./schema.ts";

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Settings",
    bindings: {
      uparrow: "list:prev",
      downarrow: "list:next",
      return: "list:edit",
      "/": "search:focus",
    },
  },
  {
    context: "Search",
    bindings: {
      escape: "search:clear",
      return: "list:edit",
    },
  },
  {
    context: "Confirm",
    bindings: {
      y: "confirm:yes",
      Y: "confirm:yes",
      n: "confirm:no",
      N: "confirm:no",
      escape: "confirm:no",
    },
  },
  {
    context: "Field",
    bindings: {
      escape: "field:cancel",
      return: "field:commit",
      "ctrl+r": "field:reveal-secret",
    },
  },
];
