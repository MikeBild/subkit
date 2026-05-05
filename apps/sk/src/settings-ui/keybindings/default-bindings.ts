// Default keybindings for `sk settings configure`.
//
// Operator overrides are not yet wired in — the loader call site
// pulls from this map directly. When we add `~/.sk/keybindings.json`
// (mirroring claude-code's pattern), `useKeybinding` will merge the
// operator's overlay over these defaults the same way claude-code's
// `loadBindings` does.

import type { KeybindingBlock } from "./schema.ts";

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Settings",
    bindings: {
      tab: "settings:tab-next",
      "shift+tab": "settings:tab-prev",
      uparrow: "list:prev",
      downarrow: "list:next",
      return: "list:edit",
      escape: "settings:close",
      q: "settings:close",
      "/": "search:focus",
      "?": "help:toggle",
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
  {
    // The Global context covers app-level concerns the modal shouldn't
    // intercept (Ctrl-C exits via Ink's built-in handler).
    context: "Global",
    bindings: {},
  },
];
