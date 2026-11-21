import { hostname } from "node:os";
import { resolve } from "node:path";
import { app, type BrowserWindow, dialog, type Session } from "electron";
import { type Locale, t } from "../shared/i18n.ts";
import { CONNECT_CHANNELS, type LocalView } from "../shared/ipc.ts";
import {
  applyLocalSignIn,
  dropLocalProfile,
  isLocalActive,
  type LocalSignIn,
} from "../shared/local/local-profile.ts";
import { moveServerTarget, parseFinishInput } from "../shared/local/local-workspace-model.ts";
import { profileIdFor, type StoreData } from "../shared/profiles.ts";
import { deviceLabel } from "../shared/server-contract.ts";
import type { ErrorLog } from "./error-log.ts";
import type { IpcHandle } from "./local-ipc.ts";
import { LocalWorkspaceController } from "./local-workspace.ts";
import type { SecretVault } from "./vault.ts";

export interface LocalShellHost {
  errors: ErrorLog;
  vault: SecretVault;
  data(): StoreData;
  update(change: (data: StoreData) => StoreData): void;
  locale(): Locale;
  sessionFor(origin: string): Session;
  connectWindow(): BrowserWindow | null;
  render(): void;
  startFeed(): void;
  reloadCockpit(profileId: string): boolean;
  open(): void;
  openProfile(profileId: string): void;
}

export class LocalWorkspaceShell {
  readonly controller: LocalWorkspaceController;

  constructor(private readonly host: LocalShellHost) {
    this.controller = new LocalWorkspaceController({
      userData: app.getPath("userData"),
      vault: host.vault,
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repo: resolve(app.getAppPath(), "../.."),
      deviceLabel: () => deviceLabel(hostname()),
      sessionFor: (origin) => host.sessionFor(origin),
      window: () => host.connectWindow(),
      onChange: () => host.render(),
      onSignedIn: (signedIn, setup) => this.signedIn(signedIn, setup),
      onGone: (origin) => this.gone(origin),
      onSecret: (secret) => host.errors.addSecret(secret),
      onError: (scope, error) => host.errors.record(scope, error),
    });
  }

  get running(): boolean {
    return this.controller.running;
  }

  start(): void {
    this.controller.start();
  }

  stop(): Promise<void> {
    return this.controller.stop();
  }

  holdsOpen(): boolean {
    return this.activeIsLocal() && !this.controller.ready;
  }

  view(): LocalView {
    return this.controller.view(this.activeIsLocal());
  }

  private activeIsLocal(): boolean {
    return isLocalActive(this.host.data(), this.controller.origin);
  }

  private signedIn(signedIn: LocalSignIn, setup: boolean): void {
    const label = t(this.host.locale(), "workspace.workspace");
    this.host.update((data) =>
      applyLocalSignIn(data, signedIn, { setup, label, version: app.getVersion() }),
    );
    this.host.render();
    if (setup || !this.activeIsLocal()) return;
    this.host.startFeed();
    if (
      !this.host.reloadCockpit(profileIdFor(signedIn.origin)) &&
      this.host.connectWindow()?.isVisible()
    )
      this.host.open();
  }

  private gone(origin: string | null): void {
    if (origin)
      void this.host
        .sessionFor(origin)
        .clearStorageData()
        .catch(() => {});
    this.host.update((data) => dropLocalProfile(data, origin));
    this.host.startFeed();
    this.host.render();
  }

  async confirmRestart(): Promise<boolean> {
    if (!this.controller.running) return true;
    const runs = await this.controller.activeRuns();
    if (runs > 0) {
      const locale = this.host.locale();
      const options = {
        type: "warning" as const,
        message: t(locale, "workspace.update.title"),
        detail: t(locale, "workspace.update.body", { count: runs }),
        buttons: [t(locale, "workspace.update.restart"), t(locale, "updates.later")],
        defaultId: 1,
        cancelId: 1,
      };
      const parent = this.host.connectWindow();
      const choice = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (choice.response !== 0) return false;
    }
    await this.controller.stop();
    return true;
  }

  registerIpc(handle: IpcHandle): void {
    const local = this.controller;
    handle(CONNECT_CHANNELS.localPickDataFolder, () => local.pickFolder());
    handle(CONNECT_CHANNELS.localBegin, () => void local.begin());
    handle(CONNECT_CHANNELS.localFinish, (raw) => {
      const input = parseFinishInput(raw);
      if (input) void local.finish(input);
    });
    handle(CONNECT_CHANNELS.localCancel, () => local.cancel());
    handle(CONNECT_CHANNELS.localOpen, () => {
      if (local.origin && local.ready) this.host.openProfile(profileIdFor(local.origin));
    });
    handle(CONNECT_CHANNELS.localBackup, () => local.backup());
    handle(CONNECT_CHANNELS.localRestore, (name) =>
      typeof name === "string" ? local.restore(name) : undefined,
    );
    handle(CONNECT_CHANNELS.localMove, (raw) => {
      const target = moveServerTarget(raw);
      return target ? local.move(target) : undefined;
    });
    handle(CONNECT_CHANNELS.localRemoveAll, () => local.removeAll());
  }
}
