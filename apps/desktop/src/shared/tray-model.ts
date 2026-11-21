import { badgeLabel } from "./attention.ts";
import { clockLabel, type Locale, t } from "./i18n.ts";
import type { Mute } from "./quiet-hours.ts";

export type Connection = "signed-out" | "connecting" | "online" | "offline" | "expired" | "revoked";

export interface TrayModel {
  locale: Locale;
  count: number;
  connection: Connection;
  mute: Mute | null;
  update: MenuUpdateItem | null;
  quickCapture: string | null;
  launchAtLogin: { checked: boolean; enabled: boolean };
  liveView: boolean;
}

export interface MenuUpdateItem {
  label: string;
  enabled: boolean;
}

export type TrayAction =
  | "open"
  | "needsYou"
  | "pause"
  | "resume"
  | "launchAtLogin"
  | "update"
  | "quickCapture"
  | "liveView"
  | "settings"
  | "reportProblem"
  | "quit";

export type TrayMenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      action: TrayAction;
      label: string;
      sublabel?: string;
      enabled: boolean;
      checked?: boolean;
      accelerator?: string;
    };

export function trayStatus(model: Pick<TrayModel, "locale" | "connection" | "count">): string {
  const { locale, connection, count } = model;
  if (connection === "offline") return t(locale, "tray.status.offline");
  if (connection === "signed-out") return t(locale, "tray.status.signedOut");
  if (connection === "expired" || connection === "revoked")
    return t(locale, "tray.status.reconnect");
  return count > 0 ? t(locale, "tray.needsYou", { count }) : t(locale, "tray.needsYou.none");
}

export function muteLabel(locale: Locale, mute: Mute): string {
  const paused = mute.reason === "paused";
  if (!mute.until) return t(locale, paused ? "tray.paused" : "tray.quiet");
  const time = clockLabel(locale, mute.until);
  return t(locale, paused ? "tray.pausedUntil" : "tray.quietUntil", { time });
}

export function trayTooltip(appName: string, model: TrayModel): string {
  const status = trayStatus(model);
  return model.mute
    ? `${appName} – ${status} · ${muteLabel(model.locale, model.mute)}`
    : `${appName} – ${status}`;
}

export function trayTitle(model: Pick<TrayModel, "connection" | "count">): string {
  return model.connection === "online" || model.connection === "connecting"
    ? badgeLabel(model.count)
    : "";
}

export function trayMenu(model: TrayModel): TrayMenuItem[] {
  const { locale, mute } = model;
  const live = model.connection === "online" || model.connection === "connecting";
  const items: TrayMenuItem[] = [
    { kind: "item", action: "open", label: t(locale, "tray.open"), enabled: true },
    { kind: "item", action: "needsYou", label: trayStatus(model), enabled: live },
    ...(model.liveView
      ? [
          {
            kind: "item" as const,
            action: "liveView" as const,
            label: t(locale, "tray.liveView"),
            enabled: true,
          },
        ]
      : []),
    { kind: "separator" },
  ];
  const paused = mute?.reason === "paused";
  items.push({
    kind: "item",
    action: paused ? "resume" : "pause",
    label: t(locale, paused ? "tray.resume" : "tray.pause"),
    ...(mute ? { sublabel: muteLabel(locale, mute) } : {}),
    enabled: true,
  });
  items.push({
    kind: "item",
    action: "launchAtLogin",
    label: t(locale, "tray.launchAtLogin"),
    enabled: model.launchAtLogin.enabled,
    checked: model.launchAtLogin.checked,
  });
  if (model.update)
    items.push({
      kind: "item",
      action: "update",
      label: model.update.label,
      enabled: model.update.enabled,
    });
  if (model.quickCapture)
    items.push({
      kind: "item",
      action: "quickCapture",
      label: t(locale, "tray.quickCapture"),
      enabled: live,
      accelerator: model.quickCapture,
    });
  items.push(
    { kind: "separator" },
    { kind: "item", action: "settings", label: t(locale, "menu.settings"), enabled: true },
    {
      kind: "item",
      action: "reportProblem",
      label: t(locale, "menu.reportProblem"),
      enabled: true,
    },
    { kind: "item", action: "quit", label: t(locale, "tray.quit"), enabled: true },
  );
  return items;
}

export function quickCaptureAccelerator(platform: string): string {
  return platform === "darwin" ? "Alt+Space" : "Control+Alt+Space";
}

export const TRAY_TEMPLATE_POINTS = 18;
export const TRAY_COLOR_POINTS = 24;

export function trayImage(platform: string): {
  file: "trayTemplate.png" | "icon.png";
  template: boolean;
  size: number;
} {
  return platform === "darwin"
    ? { file: "trayTemplate.png", template: true, size: TRAY_TEMPLATE_POINTS }
    : { file: "icon.png", template: false, size: TRAY_COLOR_POINTS };
}
