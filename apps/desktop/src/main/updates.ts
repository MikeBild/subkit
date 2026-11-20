import { app } from "electron";
import {
  initialUpdateState,
  reduceUpdate,
  type UpdateEvent,
  type UpdateState,
  updateBusy,
} from "../shared/updates.ts";
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
    autoUpdater.on("update-not-available", () => this.dispatch({ type: "not-available" }));
    autoUpdater.on("update-available", (info) =>
      this.dispatch({ type: "available", version: info.version }),
    );
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
    this.hooks.onError("updates", error);
    this.dispatch({ type: "error", message: messageOf(error) });
  }

  private dispatch(event: UpdateEvent): void {
    const next = reduceUpdate(this.state, event);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.hooks.onState(next);
  }
}
