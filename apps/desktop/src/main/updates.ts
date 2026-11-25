import { homedir, tmpdir } from "node:os";
import { app } from "electron";
import {
  classifyUpdateError,
  initialUpdateState,
  reduceUpdate,
  restartRequest,
  type UpdateEvent,
  type UpdateState,
  updateBusy,
  updateErrorEvent,
} from "../shared/updates.ts";
import { appLog } from "./app-log.ts";
import { CHANNEL } from "./channel.ts";
import {
  type DiagnosticsEnv,
  type DiagnosticsIo,
  type DiagnosticsLog,
  logVolumes,
  nodeDiagnosticsIo,
  recordInstallAttempt,
  reportPreviousUpdate,
} from "./update-diagnostics.ts";

declare const SUBKIT_DESKTOP_UPDATES: boolean;

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface UpdateHooks {
  onState(state: UpdateState): void;
  onError(scope: string, error: unknown): void;
}

export interface UpdateDiagnostics {
  previousAttempt(): void;
  downloaded(version: string): void;
  beforeInstall(version: string): void;
}

function diagnosticsEnv(): DiagnosticsEnv {
  return {
    execPath: process.execPath,
    tmpDir: tmpdir(),
    homeDir: homedir(),
    userDataDir: app.getPath("userData"),
    bundleId: CHANNEL.appId,
    platform: process.platform,
    version: app.getVersion(),
  };
}

export function updateDiagnostics(
  env: () => DiagnosticsEnv = diagnosticsEnv,
  io: DiagnosticsIo = nodeDiagnosticsIo,
  log: DiagnosticsLog = appLog,
): UpdateDiagnostics {
  const guarded = (stage: string, run: (current: DiagnosticsEnv) => void) => {
    try {
      run(env());
    } catch (error) {
      log.warn("update.diagnostics_failed", { stage, error: messageOf(error) });
    }
  };
  return {
    previousAttempt: () => guarded("launch", (current) => reportPreviousUpdate(current, io, log)),
    downloaded: (version) =>
      guarded("downloaded", (current) => logVolumes("downloaded", version, current, io, log)),
    beforeInstall: (version) =>
      guarded("before_install", (current) => recordInstallAttempt(version, current, io, log)),
  };
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
  private reported = false;

  constructor(
    private readonly hooks: UpdateHooks,
    private readonly diagnostics: UpdateDiagnostics = updateDiagnostics(),
  ) {}

  get current(): UpdateState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    if (!this.reported) {
      this.reported = true;
      this.diagnostics.previousAttempt();
    }
    if (this.state.phase === "disabled") return;
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
      this.diagnostics.downloaded(info.version);
      this.install = () => {
        this.diagnostics.beforeInstall(info.version);
        autoUpdater.quitAndInstall();
      };
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
    const request = restartRequest(this.state, this.install !== null);
    if (request !== "install") return request === "pending";
    const install = this.install;
    this.install = null;
    this.dispatch({ type: "install" });
    install?.();
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
