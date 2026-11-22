import { hostname } from "node:os";
import { app, globalShortcut } from "electron";
import { badgeLabel } from "../shared/attention.ts";
import { dictionary, t } from "../shared/i18n.ts";
import { COCKPIT_CHANNELS, CONNECT_CHANNELS, type ConnectState } from "../shared/ipc.ts";
import { platformCapabilities } from "../shared/platform-capabilities.ts";
import { activeProfile, isSignedIn } from "../shared/profiles.ts";
import { deviceLabel } from "../shared/server-contract.ts";
import { profileSummaries } from "../shared/shell-session.ts";
import { type ShellStatus, shellStatus } from "../shared/status-model.ts";
import { quickCaptureAccelerator } from "../shared/tray-model.ts";
import { applyMenu } from "./menu.ts";
import type { ShellCore } from "./shell-core.ts";
import type { TrayController } from "./tray.ts";
import { setBadge } from "./windows.ts";

export class ShellPresenter {
  tray: TrayController | null = null;
  private shortcut: string | null = null;

  constructor(private readonly core: ShellCore) {}

  connectState(): ConnectState {
    const { core } = this;
    const { settings } = core.store.data;
    const locale = core.locale();
    const { view, login, notice, signedIn, onboarding } = core.state;
    return {
      appVersion: app.getVersion(),
      deviceLabel: deviceLabel(hostname()),
      locale,
      messages: dictionary(locale),
      view,
      profiles: profileSummaries(core.store.data),
      settings: {
        locale: settings.locale,
        launchAtLogin: core.settings.launchAtLogin(),
        quietHours: settings.quietHours,
        notifications: settings.notifications,
        shareDiagnostics: settings.shareDiagnostics,
      },
      login,
      notice,
      signedIn,
      onboarding,
      update: core.updates.current,
      permissions: core.device.permissions.view(),
      local: core.localWorkspace.view(),
      platform: platformCapabilities(process.platform, process.arch),
    };
  }

  cockpitStatus(): ShellStatus {
    const { core } = this;
    return shellStatus(
      core.state.connection,
      core.updates.current,
      core.locale(),
      core.state.tooOld,
    );
  }

  render(): void {
    const { core } = this;
    const locale = core.locale();
    const { count, connection } = core.state;
    const capture = isSignedIn(activeProfile(core.store.data))
      ? quickCaptureAccelerator(process.platform)
      : null;
    this.syncShortcut(capture);
    const update = core.updates.menuItem(locale);
    this.tray?.render({
      locale,
      count,
      connection,
      mute: core.pause.mute(),
      update,
      quickCapture: capture,
      launchAtLogin: { checked: core.store.data.settings.launchAtLogin, enabled: app.isPackaged },
      liveView: core.device.liveShown(),
    });
    applyMenu(
      { locale, profiles: profileSummaries(core.store.data), update },
      {
        settings: () => core.showConnect("settings"),
        addServer: () => core.showConnect("connect"),
        openProfile: (id) => core.profiles.activate(id),
        reportProblem: () => void core.profiles.reportProblem(),
        checkUpdates: () => void core.updates.check(),
        quit: () => core.quit(),
      },
    );
    setBadge(badgeLabel(count), t(locale, "tray.needsYou", { count }), core.windows.all());
    const connect = core.windows.connect();
    if (connect && !connect.isDestroyed())
      connect.webContents.send(CONNECT_CHANNELS.state, this.connectState());
    const cockpit = core.windows.cockpitWindow();
    if (cockpit && !cockpit.isDestroyed()) {
      cockpit.webContents.send(COCKPIT_CHANNELS.statusChanged, this.cockpitStatus());
      cockpit.webContents.send(COCKPIT_CHANNELS.desktopSettingsChanged, core.settings.view());
    }
    core.shellUi.refresh();
    core.device.live.refresh();
  }

  stop(): void {
    globalShortcut.unregisterAll();
  }

  private syncShortcut(wanted: string | null): void {
    if (wanted === this.shortcut) return;
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = null;
    if (!wanted) return;
    try {
      if (globalShortcut.register(wanted, () => this.core.shellUi.openCapture()))
        this.shortcut = wanted;
      else this.core.record("shortcut", new Error(`${wanted} is taken`));
    } catch (error) {
      this.core.record("shortcut", error);
    }
  }
}
