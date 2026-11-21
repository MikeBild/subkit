import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, nativeTheme, screen } from "electron";
import type { NativeNotification } from "../shared/attention.ts";
import {
  type BrowserSheet,
  connectorPath,
  namedSheet,
  openSheet,
  reduceSheet,
  SHEET_CLOSE_MS,
  type SignInFinished,
} from "../shared/browser-sheet-model.ts";
import {
  baseName,
  choiceBlocker,
  type DropChoice,
  type DroppedFile,
  type DropSheet,
  type DropVia,
  inboxFileNote,
  inboxRoute,
  MAX_DROP_FILES,
  openDrop,
  placedHref,
  reduceDrop,
  sourceName,
} from "../shared/drop-model.ts";
import type { Locale } from "../shared/i18n.ts";
import {
  type CaptureState,
  canSend,
  INITIAL_CAPTURE,
  intakeHref,
  intakeNote,
  reduceCapture,
} from "../shared/quick-capture-model.ts";
import { shellDictionary, st } from "../shared/shell-i18n.ts";
import {
  isDropChoice,
  isShellUrl,
  SHELL_CHANNELS,
  type ShellState,
  type ShellView,
  shellUrl,
} from "../shared/shell-ipc.ts";
import { captureBounds, overlayBounds } from "../shared/window-frame.ts";
import { contentTypeOf } from "../shared/workspace-requests.ts";
import { guardWebContents, securePreferences } from "./hardening.ts";
import { PATHS } from "./windows.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

export const SHELL_PARTITION = "shell";

const SENT_CLOSE_MS = 900;

export interface ShellUiHooks {
  locale(): Locale;
  online(): boolean;
  workspace(): WorkspaceApi | null;
  cockpitWindow(): BrowserWindow | null;
  openCockpit(href: string): void;
  reloadCockpit(): void;
  notify(content: NativeNotification, onClick: () => void): void;
  openExternal(url: string): void;
  onError(scope: string, error: unknown): void;
}

interface Pending {
  path: string;
  file: DroppedFile;
}

export class ShellUi {
  private readonly windows = new Map<ShellView, BrowserWindow>();
  private capture: CaptureState = INITIAL_CAPTURE;
  private drop: DropSheet | null = null;
  private dropPaths: Pending[] = [];
  private sheet: BrowserSheet | null = null;

  constructor(private readonly hooks: ShellUiHooks) {}

  private create(view: ShellView): BrowserWindow {
    const existing = this.windows.get(view);
    if (existing && !existing.isDestroyed()) return existing;
    const parent = view === "capture" ? null : this.visibleCockpit();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const bounds =
      view === "capture"
        ? captureBounds(area)
        : overlayBounds(parent ? parent.getContentBounds() : null, area);
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      movable: view === "capture",
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: view === "capture",
      ...(parent ? { parent } : {}),
      webPreferences: securePreferences(PATHS.shellPreload, SHELL_PARTITION),
    });
    if (parent) {
      const follow = () => {
        if (!window.isDestroyed() && !parent.isDestroyed())
          window.setBounds(parent.getContentBounds());
      };
      parent.on("resize", follow);
      parent.on("move", follow);
      window.once("closed", () => {
        if (parent.isDestroyed()) return;
        parent.removeListener("resize", follow);
        parent.removeListener("move", follow);
      });
    }
    guardWebContents(window.webContents, (url) => (isShellUrl(url) ? "allow" : "deny"));
    window.on("closed", () => {
      if (this.windows.get(view) === window) this.windows.delete(view);
      this.onClosed(view);
    });
    if (view === "capture") {
      window.on("blur", () => {
        if (this.capture.phase !== "sending" && !window.isDestroyed()) window.close();
      });
    }
    this.windows.set(view, window);
    window.once("ready-to-show", () => {
      window.show();
      window.focus();
    });
    void window.loadURL(shellUrl(view)).catch((error) => this.hooks.onError("shell.load", error));
    return window;
  }

  private visibleCockpit(): BrowserWindow | null {
    const cockpit = this.hooks.cockpitWindow();
    return cockpit && !cockpit.isDestroyed() && cockpit.isVisible() ? cockpit : null;
  }

  private closeView(view: ShellView): void {
    const window = this.windows.get(view);
    if (window && !window.isDestroyed()) window.close();
  }

  private onClosed(view: ShellView): void {
    if (view === "capture" && this.capture.phase !== "sending") this.capture = INITIAL_CAPTURE;
    if (view === "drop" && this.drop?.phase !== "placing") {
      this.drop = null;
      this.dropPaths = [];
    }
    if (view === "sheet") this.sheet = null;
  }

  private state(view: ShellView): ShellState {
    const locale = this.hooks.locale();
    return {
      view,
      locale,
      platform: process.platform,
      dark: nativeTheme.shouldUseDarkColors,
      messages: shellDictionary(locale),
      online: this.hooks.online(),
      capture: this.capture,
      drop: this.drop,
      sheet: this.sheet,
    };
  }

  refresh(): void {
    for (const [view, window] of this.windows) {
      if (!window.isDestroyed()) window.webContents.send(SHELL_CHANNELS.state, this.state(view));
    }
  }

  private viewOf(event: IpcMainInvokeEvent): ShellView | null {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || !isShellUrl(frame.url)) return null;
    for (const [view, window] of this.windows) {
      if (!window.isDestroyed() && window.webContents === event.sender) return view;
    }
    return null;
  }

  registerIpc(): void {
    const handle = (
      channel: string,
      action: (view: ShellView, ...args: unknown[]) => unknown | Promise<unknown>,
    ) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const view = this.viewOf(event);
        if (!view) throw new Error("Unexpected sender");
        return action(view, ...args);
      });
    };
    handle(SHELL_CHANNELS.getState, (view) => this.state(view));
    handle(SHELL_CHANNELS.close, (view) => this.closeView(view));
    handle(SHELL_CHANNELS.sendNote, (view, text) => {
      if (view === "capture" && typeof text === "string") return this.sendNote(text);
      return undefined;
    });
    handle(SHELL_CHANNELS.place, (view, choice) => {
      if (view === "drop" && isDropChoice(choice)) return this.place(choice);
      return undefined;
    });
    handle(SHELL_CHANNELS.reopenBrowser, (view) => {
      if (view === "sheet" && this.sheet) this.hooks.openExternal(this.sheet.url);
    });
  }

  openCapture(): void {
    if (!this.hooks.workspace()) return;
    if (this.capture.phase === "sent" || this.capture.phase === "failed")
      this.capture = INITIAL_CAPTURE;
    const window = this.create("capture");
    if (window.isVisible()) window.focus();
    this.refresh();
  }

  private async sendNote(text: string): Promise<void> {
    const api = this.hooks.workspace();
    if (!api || !canSend(text, this.capture.phase, this.hooks.online())) return;
    const note = intakeNote(text, new Date(), randomUUID());
    if (!note) return;
    this.capture = reduceCapture(this.capture, { type: "send" });
    this.refresh();
    try {
      const itemId = await api.createNote(note);
      this.capture = reduceCapture(this.capture, { type: "sent", itemId });
      const locale = this.hooks.locale();
      this.hooks.notify(
        {
          id: `capture:${itemId}`,
          title: st(locale, "quick.sent"),
          body: note.title,
          href: intakeHref(itemId),
          urgency: "low",
          silent: true,
        },
        () => this.hooks.openCockpit(intakeHref(itemId)),
      );
      this.refresh();
      setTimeout(() => this.closeView("capture"), SENT_CLOSE_MS);
    } catch (error) {
      this.hooks.onError("capture.send", error);
      this.capture = reduceCapture(this.capture, { type: "failed" });
      this.refresh();
    }
  }

  async openDrop(paths: readonly string[], via: DropVia): Promise<void> {
    if (!this.hooks.workspace()) return;
    const found: Pending[] = [];
    for (const path of paths.slice(0, MAX_DROP_FILES)) {
      try {
        const info = await lstat(path);
        if (!info.isFile()) continue;
        const name = baseName(path);
        found.push({ path, file: { name, size: info.size } });
      } catch (error) {
        this.hooks.onError("drop.stat", error);
      }
    }
    if (!found.length) return;
    if (this.drop) {
      this.drop = reduceDrop(this.drop, { type: "add", files: found.map((f) => f.file), via });
      const known = new Set(this.dropPaths.map((pending) => pending.file.name));
      this.dropPaths = [...this.dropPaths, ...found.filter((f) => !known.has(f.file.name))];
    } else {
      this.drop = openDrop(
        found.map((f) => f.file),
        via,
      );
      this.dropPaths = found;
    }
    this.hooks.openCockpit("");
    this.create("drop");
    this.refresh();
  }

  private async place(choice: DropChoice): Promise<void> {
    const api = this.hooks.workspace();
    const sheet = this.drop;
    if (!api || !sheet || sheet.phase === "placing") return;
    if (choiceBlocker(choice, sheet.files, this.hooks.online())) return;
    this.drop = reduceDrop(sheet, { type: "place", choice });
    this.refresh();
    try {
      const ids: string[] = [];
      for (const { path, file } of this.dropPaths) {
        const bytes = new Uint8Array(await readFile(path));
        if (bytes.byteLength !== file.size) throw new Error("file changed while placing");
        const contentType = contentTypeOf(file.name);
        if (choice === "file") ids.push(await api.uploadFile(file.name, contentType, bytes));
        if (choice === "source")
          ids.push(
            await api.createSource({ name: file.name, contentType, bytes }, sourceName(file.name)),
          );
        if (choice === "chat") ids.push(await api.stageForChat(file.name, contentType, bytes));
        if (choice === "inbox") {
          const route = inboxRoute(file);
          if (route === "file") ids.push(await api.createInboxFile(file.name, contentType, bytes));
          if (route === "text") {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const note = inboxFileNote(file.name, text, new Date(), randomUUID());
            if (note) ids.push(await api.createNote(note));
          }
        }
      }
      const href = placedHref(choice, ids);
      this.drop = null;
      this.dropPaths = [];
      this.closeView("drop");
      this.hooks.openCockpit(href);
    } catch (error) {
      this.hooks.onError("drop.place", error);
      if (this.drop) this.drop = reduceDrop(this.drop, { type: "failed" });
      this.refresh();
    }
  }

  openSheet(url: string, connectorId: string | null): void {
    const sheet = openSheet(url, connectorId);
    if (!sheet) return;
    this.sheet = sheet;
    this.hooks.openExternal(url);
    this.create("sheet");
    this.refresh();
    if (connectorId) void this.nameSheet(connectorId);
  }

  private async nameSheet(connectorId: string): Promise<void> {
    const api = this.hooks.workspace();
    if (!api) return;
    try {
      const { status, json } = await api.send("GET", connectorPath(connectorId));
      if (status < 200 || status >= 300) return;
      const named = namedSheet(this.sheet, connectorId, json);
      if (named === this.sheet) return;
      this.sheet = named;
      this.refresh();
    } catch (error) {
      this.hooks.onError("sheet.connector", error);
    }
  }

  signInFinished(event: SignInFinished): void {
    const before = this.sheet;
    this.sheet = reduceSheet(before, { type: "finished", event });
    const phase = this.sheet?.phase;
    if (!this.sheet || this.sheet === before || phase === undefined || phase === "open") return;
    this.refresh();
    this.hooks.reloadCockpit();
    const ended = this.sheet;
    setTimeout(() => {
      if (this.sheet !== ended) return;
      this.sheet = null;
      this.closeView("sheet");
    }, SHEET_CLOSE_MS[phase]);
  }

  closeAll(): void {
    for (const view of [...this.windows.keys()]) this.closeView(view);
  }
}
