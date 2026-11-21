export interface DesktopUpdate {
  line: string;
  progress: number | null;
  action: { label: string; primary: boolean; enabled: boolean } | null;
}

export interface DesktopSettings {
  appVersion: string;
  launchAtLogin: boolean;
  launchAtLoginAvailable: boolean;
  shareDiagnostics: boolean;
  notifications: boolean;
  update: DesktopUpdate;
}

export interface DesktopSettingsPatch {
  launchAtLogin?: boolean;
  shareDiagnostics?: boolean;
  notifications?: boolean;
}

export interface DesktopSettingsBridge {
  read(): Promise<DesktopSettings | null>;
  change(patch: DesktopSettingsPatch): Promise<void>;
  runUpdate(): Promise<void>;
  subscribe(listener: (settings: DesktopSettings) => void): () => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 400): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function parseUpdate(raw: unknown): DesktopUpdate {
  const item = record(raw);
  const action = record(item?.action);
  const progress = item?.progress;
  return {
    line: text(item?.line),
    progress:
      typeof progress === "number" && Number.isFinite(progress)
        ? Math.min(100, Math.max(0, Math.round(progress)))
        : null,
    action: action
      ? {
          label: text(action.label, 80),
          primary: action.primary === true,
          enabled: action.enabled === true,
        }
      : null,
  };
}

export function parseDesktopSettings(raw: unknown): DesktopSettings | null {
  const item = record(raw);
  if (!item) return null;
  return {
    appVersion: text(item.appVersion, 40),
    launchAtLogin: item.launchAtLogin === true,
    launchAtLoginAvailable: item.launchAtLoginAvailable === true,
    shareDiagnostics: item.shareDiagnostics === true,
    notifications: item.notifications !== false,
    update: parseUpdate(item.update),
  };
}

export function desktopSettingsBridgeOf(candidate: unknown): DesktopSettingsBridge | null {
  const bridge = record(candidate);
  if (!bridge) return null;
  const { desktopSettings, updateDesktopSettings, runUpdateAction, onDesktopSettings } = bridge;
  if (
    typeof desktopSettings !== "function" ||
    typeof updateDesktopSettings !== "function" ||
    typeof runUpdateAction !== "function"
  )
    return null;
  return {
    read: async () => parseDesktopSettings(await desktopSettings.call(bridge)),
    change: async (patch) => {
      await updateDesktopSettings.call(bridge, patch);
    },
    runUpdate: async () => {
      await runUpdateAction.call(bridge);
    },
    subscribe: (listener) => {
      if (typeof onDesktopSettings !== "function") return () => {};
      const stop: unknown = onDesktopSettings.call(bridge, (raw: unknown) => {
        const settings = parseDesktopSettings(raw);
        if (settings) listener(settings);
      });
      return typeof stop === "function" ? () => void stop() : () => {};
    },
  };
}

export function desktopSettingsBridge(): DesktopSettingsBridge | null {
  return typeof window === "undefined"
    ? null
    : desktopSettingsBridgeOf((window as unknown as { subkitDesktop?: unknown }).subkitDesktop);
}
