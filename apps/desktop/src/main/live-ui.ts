import {
  app,
  BrowserWindow,
  globalShortcut,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  session,
} from "electron";
import { z } from "zod";
import { dictionary, type Locale } from "../shared/i18n.ts";
import {
  isLiveUrl,
  LIVE_CHANNELS,
  LIVE_SCREENSHOT,
  type LiveView,
  type LiveWindowState,
  liveUrl,
  liveViewOf,
  STOP_ACCELERATOR,
} from "../shared/live-ipc.ts";
import {
  askExpiresAt,
  decideLive,
  INITIAL_LIVE,
  type LiveCommand,
  type LiveDecision,
  type LiveEffect,
  type LiveEvent,
  type LiveState,
  liveSnapshot,
  overlayVisible,
  reduceLive,
  stopAvailable,
} from "../shared/local/live-view-model.ts";
import { LIVE_WINDOW, windowBackground } from "../shared/window-frame.ts";
import { serveAppFiles } from "./app-protocol.ts";
import {
  confineToAppScheme,
  guardWebContents,
  hardenSession,
  securePreferences,
} from "./hardening.ts";
import { OverlayPill } from "./overlay.ts";
import { PATHS } from "./windows.ts";

export const LIVE_PARTITION = "live";

export interface LivePort {
  stop(): void;
  confirm(confirmationId: string, decision: LiveDecision): void;
  handBack(commandId: string): void;
}

export interface LiveUiHooks {
  locale(): Locale;
  port(): LivePort | null;
  now(): number;
  onActive(active: boolean): void;
  onError(scope: string, error: unknown): void;
}

const DecideSchema = z.boolean();

export class LiveUi {
  private state: LiveState = INITIAL_LIVE;
  private screenshot: Uint8Array | null = null;
  private window: BrowserWindow | null = null;
  private shortcut = false;
  private shortcutFailed = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private readonly overlay: OverlayPill;

  constructor(private readonly hooks: LiveUiHooks) {
    this.overlay = new OverlayPill({
      preload: PATHS.livePreload,
      partition: LIVE_PARTITION,
      onError: hooks.onError,
    });
  }

  serve(): void {
    const live = session.fromPartition(LIVE_PARTITION);
    hardenSession(live, null);
    confineToAppScheme(live);
    serveAppFiles(live, PATHS.liveRoot, { path: LIVE_SCREENSHOT, read: () => this.screenshot });
  }

  push(event: LiveEvent, screenshot?: Uint8Array): void {
    if (event.type === "started") this.screenshot = null;
    if (event.type === "screenshot" && screenshot) this.screenshot = screenshot;
    this.state = reduceLive(this.state, event);
    if (event.type === "started" && this.state.open) this.reveal();
    this.sync();
  }

  show(): void {
    this.command({ type: "show" });
    if (this.state.open) this.reveal();
  }

  stop(): void {
    this.command({ type: "stop" });
  }

  session(): string | null {
    return this.state.session_id;
  }

  active(): boolean {
    return stopAvailable(this.state);
  }

  closeAll(): void {
    this.unregisterShortcut();
    if (this.expiry) clearTimeout(this.expiry);
    this.overlay.hide();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  registerIpc(): void {
    const handle = (
      channel: string,
      action: (view: LiveView, ...args: unknown[]) => unknown | Promise<unknown>,
    ) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const view = this.viewOf(event);
        if (!view) throw new Error("Unexpected sender");
        return action(view, ...args);
      });
    };
    handle(LIVE_CHANNELS.getState, (view) => this.windowState(view));
    handle(LIVE_CHANNELS.stop, () => this.stop());
    handle(LIVE_CHANNELS.decide, (view, allow) => {
      const parsed = DecideSchema.safeParse(allow);
      if (view === "window" && parsed.success)
        this.command({ type: "decide", allow: parsed.data, now: this.hooks.now() });
    });
    handle(LIVE_CHANNELS.handBack, (view) => {
      if (view === "window") this.command({ type: "hand_back" });
    });
    handle(LIVE_CHANNELS.close, (view) => {
      if (view !== "window") return;
      this.command({ type: "close" });
      if (this.window && !this.window.isDestroyed()) this.window.hide();
    });
  }

  refresh(): void {
    this.sync();
  }

  private command(command: LiveCommand): void {
    const decision = decideLive(this.state, command);
    this.state = decision.state;
    for (const effect of decision.effects) this.run(effect);
    this.sync();
  }

  private run(effect: LiveEffect): void {
    const port = this.hooks.port();
    if (!port) return;
    try {
      if (effect.kind === "stop") port.stop();
      else if (effect.kind === "confirm") port.confirm(effect.confirmation_id, effect.decision);
      else port.handBack(effect.command_id);
    } catch (error) {
      this.hooks.onError(`live.${effect.kind}`, error);
    }
  }

  private viewOf(event: IpcMainInvokeEvent): LiveView | null {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !isLiveUrl(frame.url)) return null;
    const view = liveViewOf(frame.url);
    const owner =
      view === "window"
        ? this.window && !this.window.isDestroyed()
          ? this.window.webContents
          : null
        : this.overlay.contents;
    return owner && event.sender === owner ? view : null;
  }

  private windowState(view: LiveView): LiveWindowState {
    const locale = this.hooks.locale();
    return {
      view,
      locale,
      dark: nativeTheme.shouldUseDarkColors,
      messages: dictionary(locale),
      live: liveSnapshot(this.state, this.hooks.now()),
    };
  }

  private reveal(): void {
    if (!this.window || this.window.isDestroyed()) this.window = this.create();
    else {
      this.window.show();
      this.window.focus();
    }
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: LIVE_WINDOW.width,
      height: LIVE_WINDOW.height,
      minWidth: LIVE_WINDOW.minWidth,
      minHeight: LIVE_WINDOW.minHeight,
      show: false,
      title: app.name,
      backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
      fullscreenable: false,
      webPreferences: securePreferences(PATHS.livePreload, LIVE_PARTITION),
    });
    guardWebContents(window.webContents, (url) => (isLiveUrl(url) ? "allow" : "deny"));
    window.on("close", (event) => {
      if (!this.window || this.window !== window) return;
      event.preventDefault();
      this.command({ type: "close" });
      window.hide();
    });
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
    void window.loadURL(liveUrl("window")).catch((error) => this.hooks.onError("live.load", error));
    return window;
  }

  private sync(): void {
    this.hooks.onActive(stopAvailable(this.state));
    if (overlayVisible(this.state)) this.overlay.show();
    else this.overlay.hide();
    if (stopAvailable(this.state)) this.registerShortcut();
    else this.unregisterShortcut();
    this.scheduleExpiry();
    const window = this.window && !this.window.isDestroyed() ? this.window : null;
    if (window) window.webContents.send(LIVE_CHANNELS.state, this.windowState("window"));
    this.overlay.contents?.send(LIVE_CHANNELS.state, this.windowState("overlay"));
  }

  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const at = askExpiresAt(this.state);
    const wait = at === null ? 0 : at - this.hooks.now();
    if (wait > 0) this.expiry = setTimeout(() => this.sync(), wait);
  }

  private registerShortcut(): void {
    if (this.shortcut || this.shortcutFailed) return;
    try {
      this.shortcut = globalShortcut.register(STOP_ACCELERATOR, () => this.stop());
      if (!this.shortcut)
        this.hooks.onError("live.shortcut", new Error(`${STOP_ACCELERATOR} is taken`));
    } catch (error) {
      this.hooks.onError("live.shortcut", error);
    }
    this.shortcutFailed = !this.shortcut;
  }

  private unregisterShortcut(): void {
    this.shortcutFailed = false;
    if (!this.shortcut) return;
    globalShortcut.unregister(STOP_ACCELERATOR);
    this.shortcut = false;
  }
}
