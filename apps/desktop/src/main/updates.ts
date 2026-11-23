import { app } from "electron";
import {
  classifyUpdateError,
  initialUpdateState,
  reduceUpdate,
  type UpdateEvent,
  type UpdateState,
  updateBusy,
  updateErrorEvent,
} from "../shared/updates.ts";
import { appLog } from "./app-log.ts";
import { CHANNEL } from "./channel.ts";

declare const SUBKIT_DESKTOP_UPDATES: boolean;

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface UpdateHooks {
  onState(state: UpdateState): void;
  onError(scope: string, error: unknown): void;
}

export function updatesEnabled(): boolean {
  return SUBKIT_DESKTOP_UPDATES && app.isPackaged && CHANNEL.channel === "production";
}

async function updater() {
  const { autoUpdater } = await import("electron-updater");
  return autoUpdater;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateController {
  private state: UpdateState = initialUpdateState(updatesEnabled());
  private install: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: unknown = null;

  constructor(private readonly hooks: UpdateHooks) {}

  get current(): UpdateState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase === "disabled" || this.timer) return;
    const autoUpdater = await updater();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.forceDevUpdateConfig = false;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => this.dispatch({ type: "checking" }));
    autoUpdater.on("update-not-available", (info) => {
      appLog.info("update.not_available", { latest: info.version });
      this.dispatch({ type: "not-available" });
    });
    autoUpdater.on("update-available", (info) => {
      appLog.info("update.available", { latest: info.version });
      this.dispatch({ type: "available", version: info.version });
    });
    autoUpdater.on("download-progress", (progress) =>
      this.dispatch({ type: "progress", percent: progress.percent }),
    );
    autoUpdater.on("update-downloaded", (info) => {
      this.install = () => autoUpdater.quitAndInstall();
      this.dispatch({ type: "downloaded", version: info.version });
    });
    autoUpdater.on("error", (error) => this.fail(error));
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
    await this.check();
  }

  async check(): Promise<void> {
    if (this.state.phase === "disabled" || this.state.phase === "ready") return;
    if (updateBusy(this.state)) return;
    appLog.info("update.check", { channel: CHANNEL.channel, current: app.getVersion() });
    this.lastError = null;
    this.dispatch({ type: "checking" });
    try {
      await (await updater()).checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
  }

  restart(): boolean {
    if (this.state.phase !== "ready" || !this.install) return false;
    this.install();
    return true;
  }

  private fail(error: unknown): void {
    if (error === this.lastError) return;
    this.lastError = error;
    const info = classifyUpdateError(error);
    const fields = { kind: info.kind, url: info.url, status: info.status, code: info.code };
    const event = updateErrorEvent(this.state, info, messageOf(error));
    if (event.type === "not-available") {
      appLog.warn("update.feed_missing", fields);
      this.dispatch(event);
      return;
    }
    appLog.warn("update.failed", { ...fields, phase: this.state.phase });
    this.hooks.onError("updates", error);
    this.dispatch(event);
  }

  private dispatch(event: UpdateEvent): void {
    const next = reduceUpdate(this.state, event);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    if (next.phase !== this.state.phase) appLog.info("update.state", { phase: next.phase });
    this.state = next;
    this.hooks.onState(next);
  }
}
