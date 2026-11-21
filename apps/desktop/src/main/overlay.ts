import { BrowserWindow, screen } from "electron";
import { isLiveUrl, liveUrl } from "../shared/live-ipc.ts";
import { pillBounds } from "../shared/window-frame.ts";
import { guardWebContents, securePreferences } from "./hardening.ts";

export interface OverlayOptions {
  preload: string;
  partition: string;
  onError(scope: string, error: unknown): void;
}

export class OverlayPill {
  private window: BrowserWindow | null = null;

  constructor(private readonly options: OverlayOptions) {}

  get contents(): Electron.WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (!this.window.isVisible()) this.window.showInactive();
      return;
    }
    const window = new BrowserWindow({
      ...pillBounds(screen.getPrimaryDisplay().workArea),
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: securePreferences(this.options.preload, this.options.partition),
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    guardWebContents(window.webContents, (url) => (isLiveUrl(url) ? "allow" : "deny"));
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    window.once("ready-to-show", () => window.showInactive());
    this.window = window;
    void window
      .loadURL(liveUrl("overlay"))
      .catch((error) => this.options.onError("overlay.load", error));
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }
}
