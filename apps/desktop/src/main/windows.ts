import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { CONNECT_URL, isConnectUrl } from "../shared/app-url.ts";
import type { Profile } from "../shared/profiles.ts";
import { decideNavigation } from "../shared/server-address.ts";
import { guardWebContents, securePreferences } from "./hardening.ts";

export const CONNECT_PARTITION = "connect";

const DIST = join(app.getAppPath(), "dist");

export const PATHS = {
  connectPreload: join(DIST, "preload-connect.cjs"),
  cockpitPreload: join(DIST, "preload-cockpit.cjs"),
  connectRoot: join(DIST, "connect"),
  assets: join(DIST, "assets"),
  icon: join(DIST, "assets", "icon.png"),
};

export function partitionFor(profileId: string): string {
  return `persist:server-${profileId}`;
}

export function createConnectWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: app.name,
    icon: PATHS.icon,
    autoHideMenuBar: true,
    fullscreenable: false,
    maximizable: false,
    webPreferences: securePreferences(PATHS.connectPreload, CONNECT_PARTITION),
  });
  guardWebContents(window.webContents, (url) => (isConnectUrl(url) ? "allow" : "deny"));
  void window.loadURL(CONNECT_URL).catch(() => {});
  return window;
}

export function createCockpitWindow(profile: Profile): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: app.name,
    icon: PATHS.icon,
    webPreferences: securePreferences(PATHS.cockpitPreload, partitionFor(profile.id)),
  });
  guardWebContents(window.webContents, (url) => decideNavigation(url, profile.serverOrigin));
  return window;
}

export function reveal(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function dotIcon() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 49) continue;
      pixels.set([0x26, 0x26, 0xdc, 0xff], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

export function setBadge(label: string, description: string, windows: BrowserWindow[]): void {
  if (process.platform === "darwin") {
    app.dock?.setBadge(label);
    return;
  }
  if (process.platform === "linux") {
    app.setBadgeCount(label ? Number.parseInt(label, 10) : 0);
    return;
  }
  for (const window of windows) {
    if (!window.isDestroyed())
      window.setOverlayIcon(label ? dotIcon() : null, label ? description : "");
  }
}
