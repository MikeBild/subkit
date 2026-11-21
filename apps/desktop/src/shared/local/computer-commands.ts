import { isBlockedShortcut, normalizeChord } from "@shared/local-policy/shortcuts.ts";

export const INVENTORY_TIMEOUT_MS = 5000;
export const SNAPSHOT_TIMEOUT_MS = 3000;
export const ACTION_TIMEOUT_MS = 5000;
export const SNAPSHOT_MAX_DEPTH = 50;

export const listWindowsArgs = (): string[] => [
  "list-windows",
  "--timeout-ms",
  String(INVENTORY_TIMEOUT_MS),
];

export const listAppsArgs = (): string[] => [
  "list-apps",
  "--timeout-ms",
  String(INVENTORY_TIMEOUT_MS),
];

export const snapshotArgs = (windowId: string): string[] => [
  "snapshot",
  "--window-id",
  windowId,
  "--include-bounds",
  "--compact",
  "--max-depth",
  String(SNAPSHOT_MAX_DEPTH),
  "--timeout-ms",
  String(SNAPSHOT_TIMEOUT_MS),
];

export const screenshotArgs = (windowId: string): string[] => [
  "screenshot",
  "--window-id",
  windowId,
];

export const clickArgs = (ref: string): string[] => [
  "click",
  ref,
  "--timeout-ms",
  String(ACTION_TIMEOUT_MS),
];

export const focusArgs = (ref: string): string[] => [
  "focus",
  ref,
  "--timeout-ms",
  String(ACTION_TIMEOUT_MS),
];

export const typeArgs = (ref: string): string[] => ["type", ref, "--stdin"];

export const setValueArgs = (ref: string): string[] => ["set-value", ref, "--stdin"];

export const selectArgs = (ref: string, option: string): string[] => [
  "select",
  ref,
  "--timeout-ms",
  String(ACTION_TIMEOUT_MS),
  "--",
  option,
];

export const scrollArgs = (ref: string, direction: string, amount: number): string[] => [
  "scroll",
  ref,
  "--direction",
  direction,
  "--amount",
  String(amount),
  "--timeout-ms",
  String(ACTION_TIMEOUT_MS),
];

export const pressArgs = (combo: string, windowId: string): string[] => [
  "press",
  combo,
  "--window-id",
  windowId,
];

export const pointerClickArgs = (x: number, y: number): string[] => [
  "--headed",
  "mouse-click",
  "--xy",
  `${Math.round(x)},${Math.round(y)}`,
];

const KEY_NAMES: Readonly<Record<string, string>> = {
  esc: "escape",
  enter: "return",
  backspace: "delete",
};

const ALLOWED_KEY =
  /^([a-z0-9]|f([1-9]|1[0-2])|return|escape|tab|space|delete|up|down|left|right|home|end|pageup|pagedown|comma|period|slash|semicolon|minus|equal)$/;

export type ComboResult =
  | { readonly ok: true; readonly combo: string }
  | { readonly ok: false; readonly code: "blocked_shortcut" | "bad_key" };

export function comboFor(keys: string): ComboResult {
  if (isBlockedShortcut(keys, "darwin")) return { ok: false, code: "blocked_shortcut" };
  const chord = normalizeChord(keys, "darwin");
  const key = KEY_NAMES[chord.key] ?? chord.key;
  if (!ALLOWED_KEY.test(key)) return { ok: false, code: "bad_key" };
  return { ok: true, combo: [...chord.modifiers, key].join("+") };
}

export function helperEnv(stateRoot: string): Record<string, string> {
  return { AGENT_DESKTOP_HOME: stateRoot };
}
