import { hostname } from "node:os";
import { join } from "node:path";
import { app, nativeTheme, session } from "electron";
import { loginCallback } from "../shared/channel.ts";
import { parseDeepLink } from "../shared/deep-link.ts";
import type { DropVia } from "../shared/drop-model.ts";
import { type Locale, resolveLocale } from "../shared/i18n.ts";
import type { ConnectView } from "../shared/ipc.ts";
import { completeStep } from "../shared/onboarding.ts";
import {
  activeProfile,
  dropPendingProfiles,
  isSignedIn,
  type Profile,
} from "../shared/profiles.ts";
import * as model from "../shared/shell-session.ts";
import { serveAppFiles } from "./app-protocol.ts";
import { CHANNEL } from "./channel.ts";
import { DeviceGlue } from "./device-glue.ts";
import { ErrorLog } from "./error-log.ts";
import { FeedFlow } from "./feed-flow.ts";
import { confineToAppScheme, hardenSession, openExternal } from "./hardening.ts";
import { LocalWorkspaceShell } from "./local-workspace-shell.ts";
import { LoginController } from "./login.ts";
import { showNotification } from "./notify.ts";
import { PauseFlow } from "./pause-flow.ts";
import { ProfileFlow } from "./profile-flow.ts";
import { ProfileSessions } from "./profile-sessions.ts";
import { ReportFlow } from "./report-flow.ts";
import { SettingsFlow } from "./settings-flow.ts";
import type { ShellCore } from "./shell-core.ts";
import { registerShellIpc } from "./shell-ipc.ts";
import { shellIpcHost } from "./shell-ipc-host.ts";
import { ShellPresenter } from "./shell-presenter.ts";
import { SHELL_PARTITION, ShellUi } from "./shell-ui.ts";
import { ProfileStore } from "./store.ts";
import { TrayController } from "./tray.ts";
import { UpdateFlow } from "./update-flow.ts";
import { SecretVault } from "./vault.ts";
import { WindowHost } from "./window-host.ts";
import { CONNECT_PARTITION, PATHS } from "./windows.ts";

const USER_DATA = app.getPath("userData");

export class Shell implements ShellCore {
  state: model.ShellSession = model.INITIAL_SESSION;
  private quitting = false;
  readonly errors = new ErrorLog(join(USER_DATA, "errors.json"));
  readonly store = new ProfileStore(join(USER_DATA, "profiles.json"), (error) =>
    this.record("store", error),
  );
  private readonly vault = new SecretVault(join(USER_DATA, "device-vault.json"));
  private readonly onError = (scope: string, error: unknown) => this.record(scope, error);
  readonly sessions = new ProfileSessions({ data: () => this.store.data, onError: this.onError });
  readonly presenter: ShellPresenter = new ShellPresenter(this);
  readonly feed: FeedFlow = new FeedFlow(this);
  readonly profiles: ProfileFlow = new ProfileFlow(this);
  readonly report: ReportFlow = new ReportFlow(this);
  readonly device = new DeviceGlue({
    vault: this.vault,
    locale: () => this.locale(),
    target: () => {
      const profile = activeProfile(this.store.data);
      const api = this.sessions.workspaceApi();
      return api && profile ? { api, origin: profile.serverOrigin, profileId: profile.id } : null;
    },
    render: () => this.render(),
    showPermissions: () => this.showConnect("permissions"),
    onError: this.onError,
  });
  readonly live = this.device.live;
  readonly windows = new WindowHost({
    quitting: () => this.quitting,
    openSheet: (url, connectorId) => this.shellUi.openSheet(url, connectorId),
    onLoadFailed: (profileId) => {
      this.state = model.cockpitUnreachable(this.state, profileId);
      this.showConnect("connect");
    },
    onError: this.onError,
  });
  readonly pause = new PauseFlow({
    settings: () => this.store.data.settings,
    setLocalPause: (until) =>
      this.store.update((data) => ({ ...data, settings: { ...data.settings, pauseUntil: until } })),
    api: () => this.sessions.workspaceApi(),
    render: () => this.render(),
    onError: this.onError,
  });
  readonly updates: UpdateFlow = new UpdateFlow({
    locale: () => this.locale(),
    announce: (notification) => this.feed.announce(notification),
    render: () => this.render(),
    showSettings: () => this.showConnect("settings"),
    confirmRestart: () => this.localWorkspace.confirmRestart(),
    beforeQuit: () => this.beforeQuit(),
    cancelQuit: () => {
      this.quitting = false;
    },
    onError: this.onError,
  });
  readonly settings = new SettingsFlow({
    data: () => this.store.data,
    update: (change) => this.store.update(change),
    locale: () => this.locale(),
    updateState: () => this.updates.current,
    completed: (step) => {
      this.state = { ...this.state, onboarding: completeStep(this.state.onboarding, step) };
    },
    open: () => this.open(),
    render: () => this.render(),
    onError: this.onError,
  });
  readonly shellUi: ShellUi = new ShellUi({
    locale: () => this.locale(),
    online: () => this.state.connection === "online",
    workspace: () => this.sessions.workspaceApi(),
    cockpitWindow: () => this.windows.cockpitWindow(),
    openCockpit: (href) => this.open(href),
    reloadCockpit: () => void this.windows.reloadCockpit(),
    notify: (content, onClick) => showNotification(content, () => onClick()),
    openExternal: (url) => openExternal(url),
    onError: this.onError,
  });
  readonly localWorkspace: LocalWorkspaceShell = new LocalWorkspaceShell({
    errors: this.errors,
    vault: this.vault,
    data: () => this.store.data,
    update: (change) => this.store.update(change),
    locale: () => this.locale(),
    sessionFor: (origin) => this.sessions.sessionFor(origin),
    connectWindow: () => this.windows.connect(),
    render: () => this.render(),
    startFeed: () => this.feed.start(),
    reloadCockpit: (id) => this.windows.reloadCockpit(id),
    open: () => this.open(),
    openProfile: (id) => {
      this.state = { ...this.state, signedIn: null };
      this.profiles.activate(id);
    },
  });
  readonly login = new LoginController({
    sessionFor: (origin) => this.sessions.sessionFor(origin),
    deviceId: (origin) => this.sessions.deviceIdFor(origin),
    deviceLabel: () => hostname(),
    callback: () => loginCallback(CHANNEL.scheme),
    appVersion: () => app.getVersion(),
    onPhase: (phase) => {
      this.state = model.loginMoved(this.state, phase);
      if (phase.phase === "failed") this.sessions.forgetUnused(phase.origin);
      this.render();
    },
    onSignedIn: (origin, descriptor, desktop) =>
      this.profiles.signedIn(origin, descriptor, desktop),
    onError: this.onError,
  });

  start(initialLink: string | null, hidden: boolean): void {
    this.store.load();
    this.device.load();
    this.store.update(dropPendingProfiles);
    const roots = [
      [CONNECT_PARTITION, PATHS.connectRoot],
      [SHELL_PARTITION, PATHS.shellRoot],
    ] as const;
    for (const [partition, root] of roots) {
      const scoped = session.fromPartition(partition);
      hardenSession(scoped, null);
      confineToAppScheme(scoped);
      serveAppFiles(scoped, root);
    }
    this.live.serve();
    hardenSession(session.defaultSession, null);
    registerShellIpc(shellIpcHost(this));
    this.shellUi.registerIpc();
    this.live.registerIpc();
    this.localWorkspace.start();
    this.presenter.tray = this.createTray();
    nativeTheme.on("updated", () => {
      this.shellUi.refresh();
      this.live.refresh();
    });
    this.pause.scheduleEnd();
    this.render();
    this.feed.start();
    if (initialLink) this.handleDeepLink(initialLink);
    else if (!hidden) this.open();
    void this.updates.start();
  }

  record(scope: string, error: unknown): void {
    this.errors.record(scope, error);
  }

  locale(): Locale {
    return resolveLocale(this.store.data.settings.locale, app.getLocale());
  }

  render(): void {
    this.presenter.render();
  }

  open(href?: string): void {
    const profile = activeProfile(this.store.data);
    if (!this.localWorkspace.holdsOpen() && model.showsCockpit(this.state, profile))
      this.openCockpit(profile, href);
    else this.showConnect("connect");
  }

  showConnect(view: ConnectView): void {
    this.state = model.connectShown(this.state, view);
    this.revealConnect();
  }

  revealConnect(): void {
    this.windows.revealConnect();
    this.render();
  }

  openCockpit(profile: Profile & { cockpitPath: string }, href?: string): void {
    this.sessions.sessionFor(profile.serverOrigin);
    if (this.windows.openCockpit(profile, href)) this.render();
  }

  handleDeepLink(raw: string): void {
    const link = parseDeepLink(raw, CHANNEL.scheme);
    if (!link || link.kind === "open") {
      if (!link) this.record("deep-link", new Error("ignored an unknown deep link"));
      this.open();
      return;
    }
    void this.login.handle(link).then((handled) => {
      if (!handled || this.state.login.phase === "failed") this.showConnect("connect");
    });
  }

  dropFiles(paths: string[], via: DropVia): void {
    if (isSignedIn(activeProfile(this.store.data))) void this.shellUi.openDrop(paths, via);
    else this.open();
  }

  beforeQuit(): void {
    this.quitting = true;
    this.presenter.stop();
    this.shellUi.closeAll();
    this.feed.stop();
    this.device.stop();
    this.store.flush();
  }

  quit(): void {
    this.beforeQuit();
    app.quit();
  }

  private createTray(): TrayController {
    return new TrayController(PATHS.assets, {
      open: () => this.open(),
      needsYou: () => this.open("/"),
      pause: () => void this.pause.toggle(),
      resume: () => void this.pause.toggle(),
      launchAtLogin: () => this.settings.setLaunch(!this.store.data.settings.launchAtLogin),
      update: () => void this.updates.check(),
      quickCapture: () => this.shellUi.openCapture(),
      liveView: () => this.live.show(),
      settings: () => this.showConnect("settings"),
      reportProblem: () => void this.profiles.reportProblem(),
      quit: () => this.quit(),
      dropFiles: (paths) => this.dropFiles(paths, "tray"),
    });
  }
}
