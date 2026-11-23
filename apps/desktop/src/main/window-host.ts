import type { BrowserWindow } from "electron";
import { connectorIdFromPage, isConnectorSignIn } from "../shared/browser-sheet-model.ts";
import { type PendingCapture, reusableCapture } from "../shared/capture.ts";
import { COCKPIT_CHANNELS } from "../shared/ipc.ts";
import type { Profile } from "../shared/profiles.ts";
import { cockpitUrl } from "../shared/server-address.ts";
import { captureWindow } from "./capture.ts";
import { createCockpitWindow, createConnectWindow, reveal } from "./windows.ts";

type CockpitProfile = Profile & { cockpitPath: string };

export interface WindowHostOptions {
  quitting: () => boolean;
  openSheet: (url: string, connectorId: string | null) => void;
  onLoadFailed: (profileId: string) => void;
  onError: (scope: string, error: unknown) => void;
}

export class WindowHost {
  private connectWindow: BrowserWindow | null = null;
  private cockpit: { window: BrowserWindow; profileId: string } | null = null;
  private readonly feedbackListeners = new Set<number>();
  private pendingCapture: PendingCapture | null = null;

  constructor(private readonly options: WindowHostOptions) {}

  connect(): BrowserWindow | null {
    return this.connectWindow;
  }

  cockpitWindow(): BrowserWindow | null {
    return this.cockpit?.window ?? null;
  }

  cockpitProfileId(): string | null {
    return this.cockpit?.profileId ?? null;
  }

  all(): BrowserWindow[] {
    return [this.cockpit?.window, this.connectWindow].filter((window): window is BrowserWindow =>
      Boolean(window && !window.isDestroyed()),
    );
  }

  cockpitVisible(): boolean {
    return Boolean(
      this.cockpit && !this.cockpit.window.isDestroyed() && this.cockpit.window.isVisible(),
    );
  }

  reloadCockpit(profileId?: string): boolean {
    const window = this.cockpit?.window;
    const open =
      Boolean(window && !window.isDestroyed()) &&
      (profileId === undefined || this.cockpit?.profileId === profileId);
    if (open) window?.webContents.reload();
    return open;
  }

  revealConnect(): void {
    if (!this.connectWindow || this.connectWindow.isDestroyed()) {
      const window = createConnectWindow();
      this.connectWindow = window;
      this.keepAlive(window);
      window.once("ready-to-show", () => reveal(window));
    } else reveal(this.connectWindow);
  }

  openCockpit(profile: CockpitProfile, href?: string): boolean {
    if (
      this.cockpit &&
      (this.cockpit.profileId !== profile.id || this.cockpit.window.isDestroyed())
    ) {
      this.closeCockpit();
    }
    const target = cockpitUrl(profile.serverOrigin, profile.cockpitPath, href);
    if (this.cockpit) {
      if (href) void this.cockpit.window.loadURL(target).catch(() => {});
      reveal(this.cockpit.window);
      this.connectWindow?.hide();
      return false;
    }
    const window = createCockpitWindow(profile, (url) => {
      if (!isConnectorSignIn(url, profile.serverOrigin)) return false;
      const page = window.isDestroyed() ? null : window.webContents.getURL();
      this.options.openSheet(url, connectorIdFromPage(page));
      return true;
    });
    this.cockpit = { window, profileId: profile.id };
    this.watchCockpit(window, profile.id);
    void window.loadURL(target).catch(() => {});
    this.connectWindow?.hide();
    return true;
  }

  closeCockpit(profileId?: string): void {
    if (profileId !== undefined && this.cockpit?.profileId !== profileId) return;
    const window = this.cockpit?.window;
    this.cockpit = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  feedbackListening(senderId: number, listening: boolean): void {
    if (listening) this.feedbackListeners.add(senderId);
    else this.feedbackListeners.delete(senderId);
  }

  async requestFeedback(profileId: string): Promise<boolean> {
    const open = this.cockpit?.profileId === profileId ? this.cockpit.window : null;
    const png = open ? await captureWindow(open) : null;
    this.pendingCapture = png ? { png, at: Date.now() } : null;
    if (!open || open.isDestroyed() || !this.feedbackListeners.has(open.webContents.id))
      return false;
    reveal(open);
    open.webContents.send(COCKPIT_CHANNELS.feedbackRequested);
    return true;
  }

  async captureForCockpit(): Promise<string | null> {
    const pending = reusableCapture(this.pendingCapture, Date.now());
    this.pendingCapture = null;
    if (pending) return pending;
    const window = this.cockpit?.window;
    return window ? captureWindow(window) : null;
  }

  private keepAlive(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.options.quitting()) return;
      event.preventDefault();
      window.hide();
    });
  }

  private watchCockpit(window: BrowserWindow, profileId: string): void {
    this.keepAlive(window);
    window.once("ready-to-show", () => reveal(window));
    window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.options.onError("cockpit.load", new Error(`${code} ${description}`));
      this.closeCockpit();
      this.options.onLoadFailed(profileId);
    });
    const contentsId = window.webContents.id;
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.feedbackListeners.delete(contentsId);
    });
    window.on("closed", () => this.feedbackListeners.delete(contentsId));
    window.webContents.on("render-process-gone", (_event, details) => {
      this.options.onError("cockpit.renderer", new Error(details.reason));
      if (details.reason !== "clean-exit" && !window.isDestroyed()) window.webContents.reload();
    });
  }
}
