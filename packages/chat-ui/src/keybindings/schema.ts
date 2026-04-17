// Keybinding schema — a stable registry of named bindings scoped by
// context. Mirrors Claude Code's `keybindings/schema.ts`. Host CLIs
// may override bindings at runtime; components register handlers by
// name via `useKeybinding(name, handler)`.
//
// Contexts are nested: a binding registered for `chat.palette`
// receives events only when the palette is active. The special
// `chat.global` context is always active while the chat UI is
// mounted.

export type KeybindingContext =
  | "chat.global"
  | "chat.palette"
  | "chat.confirm"
  | "chat.textarea"
  | "chat.elicit"
  | "chat.tool";

export interface KeybindingSpec {
  /** Stable name components register handlers against. */
  name: string;
  /** Human-readable description, shown in `/help`. */
  description: string;
  /** Scope under which the binding is active. */
  context: KeybindingContext;
  /** Key chord (Ink `useInput` `key` flags) or a literal character. */
  key: KeybindingKey;
}

export type KeybindingKey =
  | { type: "char"; char: string; ctrl?: boolean; shift?: boolean; meta?: boolean }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "tab"; shift?: boolean }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "upArrow" }
  | { type: "downArrow" }
  | { type: "leftArrow" }
  | { type: "rightArrow" };

export const defaultKeybindings: KeybindingSpec[] = [
  // Global — always active.
  {
    name: "submit",
    description: "Submit the current prompt",
    context: "chat.global",
    key: { type: "enter" },
  },
  {
    name: "cancel",
    description: "Cancel the current turn",
    context: "chat.global",
    key: { type: "escape" },
  },
  {
    name: "interrupt",
    description: "Send a cancel signal to the running conversation; press again within 2s to exit",
    context: "chat.global",
    key: { type: "char", char: "c", ctrl: true },
  },
  {
    name: "redraw",
    description: "Force a redraw of the terminal",
    context: "chat.global",
    key: { type: "char", char: "l", ctrl: true },
  },
  {
    name: "historyPrev",
    description: "Cycle to the previous prompt in history",
    context: "chat.global",
    key: { type: "upArrow" },
  },
  {
    name: "historyNext",
    description: "Cycle to the next prompt in history",
    context: "chat.global",
    key: { type: "downArrow" },
  },
  {
    name: "togglePlanMode",
    description: "Toggle plan mode (read-only preview, no commit)",
    context: "chat.global",
    key: { type: "char", char: "p", ctrl: true },
  },
  {
    name: "toggleAutoMode",
    description: "Toggle auto-approve for non-destructive confirms",
    context: "chat.global",
    key: { type: "char", char: "a", ctrl: true },
  },
  {
    name: "toggleVerbose",
    description: "Toggle verbose mode (show reasoning and tool-call input)",
    context: "chat.global",
    key: { type: "char", char: "v", ctrl: true },
  },
  {
    name: "toggleThinking",
    description: "Expand / collapse the nearest thinking block",
    context: "chat.global",
    key: { type: "char", char: "o", ctrl: true },
  },
  {
    name: "copyFocused",
    description: "Copy the focused message / tool-result to the clipboard",
    context: "chat.global",
    key: { type: "char", char: "c", ctrl: true, shift: true },
  },
  // Palette.
  {
    name: "paletteMove",
    description: "Move selection down in the slash palette",
    context: "chat.palette",
    key: { type: "tab" },
  },
  // Confirm prompts.
  {
    name: "confirmApprove",
    description: "Approve the current confirm prompt",
    context: "chat.confirm",
    key: { type: "char", char: "1" },
  },
  {
    name: "confirmReject",
    description: "Reject the current confirm prompt",
    context: "chat.confirm",
    key: { type: "char", char: "3" },
  },
  {
    name: "confirmToggleReason",
    description: "Reveal / hide the feedback textarea for a decision reason",
    context: "chat.confirm",
    key: { type: "tab" },
  },
];
