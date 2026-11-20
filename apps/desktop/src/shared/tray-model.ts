import { badgeLabel } from "./attention.ts";
import { type Locale, t } from "./i18n.ts";

export type Connection = "signed-out" | "connecting" | "online" | "offline" | "expired" | "revoked";

export interface TrayModel {
  locale: Locale;
  count: number;
  connection: Connection;
  paused: boolean;
  launchAtLogin: boolean;
  update: MenuUpdateItem | null;
}

export interface MenuUpdateItem {
  label: string;
  enabled: boolean;
}

export function trayStatus(model: Pick<TrayModel, "locale" | "connection" | "count">): string {
  const { locale, connection, count } = model;
  if (connection === "offline") return t(locale, "tray.status.offline");
  if (connection === "signed-out") return t(locale, "tray.status.signedOut");
  if (connection === "expired" || connection === "revoked")
    return t(locale, "tray.status.reconnect");
  return count > 0 ? t(locale, "tray.needsYou", { count }) : t(locale, "tray.needsYou.none");
}

export function trayTooltip(appName: string, model: TrayModel): string {
  const status = trayStatus(model);
  return model.paused
    ? `${appName} – ${status} · ${t(model.locale, "tray.paused")}`
    : `${appName} – ${status}`;
}

export function trayTitle(model: Pick<TrayModel, "connection" | "count">): string {
  return model.connection === "online" || model.connection === "connecting"
    ? badgeLabel(model.count)
    : "";
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
