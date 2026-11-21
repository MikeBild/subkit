export const NAV_SHORTCUT_COUNT = 9;

export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function navShortcutIndex(event: ShortcutKey, mac: boolean): number | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey || event.shiftKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}

export function navShortcutTarget(input: {
  event: ShortcutKey;
  mac: boolean;
  appWindow: boolean;
  paths: readonly string[];
}): string | null {
  if (!input.appWindow) return null;
  const index = navShortcutIndex(input.event, input.mac);
  return index === null ? null : (input.paths[index] ?? null);
}

export function navShortcutLabel(index: number, mac: boolean): string | null {
  if (index < 0 || index >= NAV_SHORTCUT_COUNT) return null;
  return `${mac ? "⌘" : "Ctrl+"}${index + 1}`;
}

export function navShortcutAria(index: number): string | null {
  if (index < 0 || index >= NAV_SHORTCUT_COUNT) return null;
  return `Meta+${index + 1} Control+${index + 1}`;
}
