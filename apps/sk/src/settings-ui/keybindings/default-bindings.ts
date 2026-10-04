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
