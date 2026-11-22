import { join } from "node:path";
import { app, BrowserWindow, nativeImage, nativeTheme, screen } from "electron";
import { CONNECT_URL, isConnectUrl } from "../shared/app-url.ts";
import type { Profile } from "../shared/profiles.ts";
import { decideNavigation } from "../shared/server-address.ts";
import { COCKPIT_WINDOW, initialWindowSize, windowBackground } from "../shared/window-frame.ts";
import { appLog } from "./app-log.ts";
import { guardWebContents, securePreferences } from "./hardening.ts";

export const CONNECT_PARTITION = "connect";

const DIST = join(app.getAppPath(), "dist");

export const PATHS = {
  connectPreload: join(DIST, "preload-connect.cjs"),
  cockpitPreload: join(DIST, "preload-cockpit.cjs"),
  shellPreload: join(DIST, "preload-shell.cjs"),
  livePreload: join(DIST, "preload-live.cjs"),
  connectRoot: join(DIST, "connect"),
  shellRoot: join(DIST, "shell"),
  runner: join(DIST, "runner.cjs"),
  liveRoot: join(DIST, "live"),
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
  appLog.info("window.connect.created");
  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3)
      appLog.warn("window.connect.load_failed", { error_code: code, description });
  });
  void window.loadURL(CONNECT_URL).catch((error) => appLog.error("window.connect.load", error));
  return window;
}

export function createCockpitWindow(
  profile: Profile,
  intercept: (url: string) => boolean = () => false,
): BrowserWindow {
  const window = new BrowserWindow({
    ...initialWindowSize(screen.getPrimaryDisplay().workAreaSize),
    minWidth: COCKPIT_WINDOW.minWidth,
    minHeight: COCKPIT_WINDOW.minHeight,
    show: false,
    title: app.name,
    icon: PATHS.icon,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    webPreferences: securePreferences(PATHS.cockpitPreload, partitionFor(profile.id)),
  });
  appLog.info("window.cockpit.created");
  guardWebContents(window.webContents, (url) => {
    const decision = decideNavigation(url, profile.serverOrigin);
    return decision === "external" && intercept(url) ? "deny" : decision;
  });
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
