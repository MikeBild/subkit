export const LOCAL_SETTINGS_PROTOCOL = 7;

export type OpenLocalSettings = () => void;

export function localSettingsOpenerOf(candidate: unknown): OpenLocalSettings | null {
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as { protocolVersion?: unknown; openLocalCapabilities?: unknown };
  const { protocolVersion } = bridge;
  if (typeof protocolVersion !== "number" || protocolVersion < LOCAL_SETTINGS_PROTOCOL) return null;
  const open = bridge.openLocalCapabilities;
  if (typeof open !== "function") return null;
  return () => void open.call(bridge);
}

export function localSettingsOpener(): OpenLocalSettings | null {
  return typeof window === "undefined"
    ? null
    : localSettingsOpenerOf((window as unknown as { subkitDesktop?: unknown }).subkitDesktop);
}
