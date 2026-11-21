import type { DeviceOs } from "../device/protocol.ts";

export type Modifier = "cmd" | "ctrl" | "alt" | "shift" | "win" | "fn";

export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

const MODIFIER_ORDER: readonly Modifier[] = ["fn", "ctrl", "alt", "shift", "cmd", "win"];

export const SYSTEM_KEY_ALIASES: readonly string[] = [
  "cmd",
  "command",
  "⌘",
  "meta",
  "super",
  "win",
  "windows",
  "os",
  "start",
  "⊞",
];

export const MODIFIER_ALIASES: Readonly<Record<string, Exclude<Modifier, "cmd" | "win">>> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  "⌃": "ctrl",
  "^": "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  altgr: "alt",
  "⌥": "alt",
  shift: "shift",
  "⇧": "shift",
  fn: "fn",
  globe: "fn",
  function: "fn",
};

export const KEY_ALIASES: Readonly<Record<string, string>> = {
  escape: "esc",
  "⎋": "esc",
  return: "enter",
  "↩": "enter",
  "⏎": "enter",
  spacebar: "space",
  "": "space",
  prtsc: "printscreen",
  prtscn: "printscreen",
  prntscrn: "printscreen",
  print: "printscreen",
  print_screen: "printscreen",
  "print screen": "printscreen",
  snapshot: "printscreen",
  del: "delete",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  "←": "left",
  "→": "right",
  "↑": "up",
  "↓": "down",
  backquote: "`",
  grave: "`",
  backtick: "`",
  "⇥": "tab",
  "⏏": "eject",
  media_eject: "eject",
  sleep: "power",
};

function modifierOf(token: string, os: DeviceOs): Modifier | undefined {
  if (SYSTEM_KEY_ALIASES.includes(token)) return os === "darwin" ? "cmd" : "win";
  return MODIFIER_ALIASES[token];
}

function tokensOf(keys: string | readonly string[]): string[] {
  const raw = typeof keys === "string" ? keys.split(/\+(?=.)/) : keys;
  return raw.map((token) => token.trim().toLowerCase());
}

export function normalizeChord(keys: string | readonly string[], os: DeviceOs): Chord {
  const modifiers = new Set<Modifier>();
  let key = "";
  for (const token of tokensOf(keys)) {
    const modifier = modifierOf(token, os);
    if (modifier === undefined) key = KEY_ALIASES[token] ?? token;
    else modifiers.add(modifier);
  }
  return { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key };
}

function chordText(chord: Chord): string {
  return [...chord.modifiers, chord.key].join("+");
}

export const DARWIN_BLOCKED_SHORTCUTS: ReadonlySet<string> = new Set([
  "cmd+tab",
  "shift+cmd+tab",
  "cmd+q",
  "alt+cmd+q",
  "ctrl+cmd+q",
  "shift+cmd+q",
  "alt+shift+cmd+q",
  "alt+cmd+esc",
  "alt+shift+cmd+esc",
  "shift+cmd+esc",
  "cmd+space",
  "alt+cmd+space",
  "ctrl+space",
  "ctrl+alt+space",
  "shift+cmd+3",
  "shift+cmd+4",
  "shift+cmd+5",
  "shift+cmd+6",
  "ctrl+shift+cmd+3",
  "ctrl+shift+cmd+4",
  "cmd+h",
  "alt+cmd+h",
  "cmd+m",
  "alt+cmd+m",
  "alt+cmd+d",
  "ctrl+cmd+f",
  "ctrl+up",
  "ctrl+down",
  "ctrl+left",
  "ctrl+right",
  "ctrl+f2",
  "ctrl+f3",
  "ctrl+f8",
  "cmd+f5",
  "alt+cmd+f5",
  "f3",
  "f4",
  "f11",
  "f12",
  "cmd+f3",
]);

export const WINDOWS_BLOCKED_SHORTCUTS: ReadonlySet<string> = new Set([
  "alt+tab",
  "alt+shift+tab",
  "ctrl+alt+tab",
  "alt+esc",
  "alt+shift+esc",
  "alt+f4",
  "ctrl+alt+delete",
  "ctrl+alt+end",
  "ctrl+shift+esc",
  "ctrl+alt+shift+esc",
  "ctrl+esc",
  "alt+space",
  "ctrl+alt+up",
  "ctrl+alt+down",
  "ctrl+alt+left",
  "ctrl+alt+right",
  "ctrl+alt+shift+b",
]);

export const ALWAYS_BLOCKED_KEYS: ReadonlySet<string> = new Set([
  "power",
  "eject",
  "lock",
  "printscreen",
]);

export function isBlockedShortcut(keys: string | readonly string[], os: DeviceOs): boolean {
  const chord = normalizeChord(keys, os);
  if (ALWAYS_BLOCKED_KEYS.has(chord.key)) return true;
  if (os === "win32") {
    return chord.modifiers.includes("win") || WINDOWS_BLOCKED_SHORTCUTS.has(chordText(chord));
  }
  if (chord.modifiers.includes("fn")) return true;
  if (chord.modifiers.includes("ctrl") && /^[0-9]$/.test(chord.key)) return true;
  return DARWIN_BLOCKED_SHORTCUTS.has(chordText(chord));
}
