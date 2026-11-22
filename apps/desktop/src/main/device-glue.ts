import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, powerMonitor, powerSaveBlocker } from "electron";
import type { Locale } from "../shared/i18n.ts";
import { helperBinaryPath } from "../shared/local/agent-desktop-bundle.ts";
import { browserCliPath } from "../shared/local/browser-runtime.ts";
import type { ComputerSnapshot } from "../shared/local/computer-allowances.ts";
import { wireAllowances } from "../shared/local/files-allowances.ts";
import {
  askedEvent,
  confirmationsPath,
  type PendingAsk,
  pendingAsks,
  requestedDevice,
  respondBody,
  respondPath,
} from "../shared/local/live-confirmations.ts";
import { endsSession } from "../shared/local/live-progress.ts";
import type { LiveDecision } from "../shared/local/live-view-model.ts";
import { permissionGranted } from "../shared/local/permission-model.ts";
import { MacPermissions } from "../shared/local/permission-port.ts";
import type { RunnerBrowserConfig, RunnerState } from "../shared/local/runner-port.ts";
import { appLog } from "./app-log.ts";
import { createBrowserHost } from "./browser-host.ts";
import { KeepAwake } from "./keep-awake.ts";
import { type LivePort, LiveUi } from "./live-ui.ts";
import { LocalWiring } from "./local-wiring.ts";
import { electronPermissionSystem } from "./permissions-mac.ts";
import { RunnerWiring } from "./runner-wiring.ts";
import type { SecretVault } from "./vault.ts";
import { PATHS } from "./windows.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

const HELPERS = {
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  resourcesPath: process.resourcesPath,
  appRoot: app.getAppPath(),
};

export interface DeviceTarget {
  api: WorkspaceApi;
  origin: string;
  profileId: string;
}

export interface DeviceGlueOptions {
  vault: SecretVault;
  locale: () => Locale;
  target: () => DeviceTarget | null;
  render: () => void;
  showPermissions: () => void;
  onError: (scope: string, error: unknown) => void;
}

const RUNNER_ENDED: ReadonlySet<RunnerState | "crashed" | "given_up"> = new Set([
  "crashed",
  "given_up",
  "stopped",
  "revoked",
]);

export class DeviceGlue {
  readonly permissions = new MacPermissions(electronPermissionSystem());
  private readonly userData = app.getPath("userData");
  private readonly browserHost = createBrowserHost({
    dataDir: join(this.userData, "browser"),
    tmpDir: app.getPath("temp"),
    cliPath: browserCliPath(HELPERS) ?? "",
    platform: process.platform,
    arch: process.arch,
    fetch,
  });
  readonly local: LocalWiring;
  readonly runner: RunnerWiring;
  readonly live: LiveUi;
  private readonly asks = new Map<string, PendingAsk>();
  private readonly awake = new KeepAwake(powerSaveBlocker);
  private liveActive = false;
  runnerState: string | null = null;
  private personalWas = false;

  constructor(private readonly options: DeviceGlueOptions) {
    const onError = options.onError;
    this.local = new LocalWiring({
      userData: this.userData,
      home: homedir(),
      target: options.target,
      onChange: () => this.changed(),
      onError,
    });
    const port: LivePort = {
      stop: () => this.runner.stop(),
      confirm: (confirmationId, decision) => void this.answer(confirmationId, decision),
      handBack: (commandId) => this.runner.handBack(commandId),
    };
    this.live = new LiveUi({
      locale: options.locale,
      port: () => port,
      now: () => Date.now(),
      onActive: (active) => {
        if (active === this.liveActive) return;
        this.liveActive = active;
        options.render();
      },
      onError,
    });
    this.runner = new RunnerWiring({
      script: PATHS.runner,
      userData: this.userData,
      version: app.getVersion(),
      locale: options.locale,
      vault: options.vault,
      allowances: this.local.allowances,
      computer: () => this.local.allowances.computer(this.computerHelper()),
      browser: (runnerId) => this.browserConfig(runnerId),
      browserHost: this.browserHost,
      permissions: () => this.permissions.check().permissions,
      onLive: (event, screenshot) => {
        if (event.type === "started")
          this.awake.apply({ type: "task_started", session_id: event.session_id });
        this.live.push(event, screenshot);
      },
      onBusy: (commandId, busy) =>
        this.awake.apply({ type: busy ? "step_started" : "step_ended", command_id: commandId }),
      onExit: (code) => {
        appLog.info("runner.exit", { exit_code: code });
        this.awake.apply({ type: "runner_ended" });
      },
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      target: options.target,
      onEnrolled: () => this.local.sync(),
      onState: (state) => {
        this.runnerState = state;
        appLog[state === "crashed" || state === "given_up" ? "warn" : "info"]("runner.state", {
          runner_state: state,
        });
        if (RUNNER_ENDED.has(state)) this.awake.apply({ type: "runner_ended" });
      },
      onError,
    });
  }

  load(): void {
    this.local.load();
    this.personalWas = this.local.allowances.personalEnabled();
  }

  liveShown(): boolean {
    return this.liveActive;
  }

  refresh(): void {
    this.runner.refresh();
    this.local.sync();
  }

  permissionsChecked(): void {
    this.permissions.check();
    this.runner.computerChanged();
  }

  onStreamEvent(name: string, data: string): void {
    if (endsSession(name, data, this.live.session())) {
      this.awake.apply({ type: "task_ended" });
      this.live.push({ type: "finished" });
    }
    const device = requestedDevice(name, data);
    if (device !== null) void this.loadAsks(device);
  }

  stop(): void {
    this.awake.apply({ type: "runner_ended" });
    this.live.closeAll();
    this.local.stop();
    void this.runner.shutdown();
  }

  private computerHelper(): ComputerSnapshot["helper"] {
    const path = helperBinaryPath(HELPERS);
    if (path === null || !existsSync(path)) return null;
    const state_root = join(this.userData, "computer");
    try {
      mkdirSync(state_root, { recursive: true, mode: 0o700 });
      chmodSync(state_root, 0o700);
    } catch (error) {
      this.options.onError("computer.state", error);
      return null;
    }
    return { path, state_root };
  }

  private browserConfig(runnerId: string): RunnerBrowserConfig | null {
    const runtime = this.browserHost.runtime();
    if (runtime === null) return null;
    const sites = wireAllowances(runnerId, {
      folders: [],
      keep_out: [],
      sites: [...this.local.allowances.sites()],
    });
    return {
      cli_path: runtime.cli_path,
      version: runtime.version,
      data_dir: join(this.userData, "browser"),
      sites: sites.flatMap((site) => (site.kind === "site" ? [site] : [])),
    };
  }

  private changed(): void {
    const personal = this.local.allowances.personalEnabled();
    if (personal && !this.personalWas) this.personalTurnedOn();
    this.personalWas = personal;
    this.runner.allowancesChanged();
    this.runner.computerChanged();
    if (this.local.allowances.sites().length > 0 && this.browserHost.state() === "missing")
      void this.browserHost
        .installChrome(AbortSignal.timeout(30 * 60_000))
        .then(() => this.runner.refresh())
        .catch((error) => this.options.onError("browser.install", error));
    this.runner.refresh();
  }

  private personalTurnedOn(): void {
    const permissions = this.permissions.check().permissions;
    const ready =
      permissionGranted(permissions, "accessibility") && permissionGranted(permissions, "screen");
    if (!ready && this.computerHelper() !== null) this.options.showPermissions();
  }

  private async loadAsks(deviceId: string): Promise<void> {
    const target = this.options.target();
    if (!target || this.local.allowances.runnerIdFor(target.origin) !== deviceId) return;
    try {
      const response = await target.api.send("GET", confirmationsPath(deviceId));
      for (const ask of pendingAsks(response.json)) {
        if (this.asks.has(ask.confirmation_id)) continue;
        this.asks.set(ask.confirmation_id, ask);
        this.live.push(askedEvent(ask, Date.now()));
      }
    } catch (error) {
      this.options.onError("live.asks", error);
    }
  }

  private async answer(confirmationId: string, decision: LiveDecision): Promise<void> {
    const ask = this.asks.get(confirmationId);
    const api = this.options.target()?.api;
    if (!ask || !api) return;
    this.asks.delete(confirmationId);
    const response = await api
      .send("POST", respondPath(ask), respondBody(decision))
      .catch((error: unknown) => {
        this.options.onError("live.confirm", error);
        return null;
      });
    if (response && response.status >= 300)
      this.options.onError("live.confirm", new Error(`respond ${response.status}`));
  }
}
