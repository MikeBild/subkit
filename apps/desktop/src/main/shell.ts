import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  dialog,
  globalShortcut,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  session,
} from "electron";
import type { NotificationPauseBody } from "../../../../packages/shared/src/notification-pause.ts";
import { isConnectUrl } from "../shared/app-url.ts";
import { type AttentionItem, badgeLabel, toNotifications } from "../shared/attention.ts";
import {
  connectorIdFromPage,
  isConnectorSignIn,
  signInFinished,
} from "../shared/browser-sheet-model.ts";
import { type PendingCapture, reusableCapture } from "../shared/capture.ts";
import { loginCallback } from "../shared/channel.ts";
import { parseDeepLink } from "../shared/deep-link.ts";
import type { DropVia } from "../shared/drop-model.ts";
import { dictionary, type Locale, resolveLocale, t } from "../shared/i18n.ts";
import { type InviteCheck, invitePageUrl, parseInviteLink } from "../shared/invite-link.ts";
import {
  type CheckResult,
  COCKPIT_CHANNELS,
  CONNECT_CHANNELS,
  type ConnectNotice,
  type ConnectState,
  type ConnectView,
  type DesktopSettingsView,
  desktopSettingsPatch,
  desktopUpdateView,
  type LoginPhase,
  type ProfileSummary,
  type SignedIn,
} from "../shared/ipc.ts";
import {
  chooseWorkspace,
  completeStep,
  LOADING_ONBOARDING,
  MEMBERSHIPS_PATH,
  NO_ONBOARDING,
  type Onboarding,
  parseMemberships,
  startOnboarding,
  TENANT_SESSION_PATH,
  tenantSessionBody,
  type WorkspaceOption,
  workspaceFailed,
} from "../shared/onboarding.ts";
import {
  type Held,
  heldHint,
  PAUSE_PATH,
  type PauseSupport,
  parsePause,
  pauseSupportOf,
  pauseToggle,
  trayMute,
} from "../shared/pause-model.ts";
import {
  activeProfile,
  dropPendingProfiles,
  findProfile,
  isSignedIn,
  type Profile,
  parseSettings,
  profileIdFor,
  removeProfile,
  signOutProfile,
  upsertProfile,
} from "../shared/profiles.ts";
import { cockpitUrl, isSameOrigin } from "../shared/server-address.ts";
import {
  type AuthFailure,
  type DesktopSession,
  deviceLabel,
  type ServiceDescriptor,
} from "../shared/server-contract.ts";
import { type TooOldAsk, tooOldAsk } from "../shared/server-too-old.ts";
import {
  type ShellTarget,
  type StatusNotification,
  shellStatus,
  statusNotice,
  statusNotification,
  updateNotice,
  updateNotification,
} from "../shared/status-model.ts";
import { type MenuUpdateItem, quickCaptureAccelerator } from "../shared/tray-model.ts";
import { type UpdateState, updateAction, updateMenuLabel } from "../shared/updates.ts";
import { serveAppFiles } from "./app-protocol.ts";
import { captureWindow } from "./capture.ts";
import { CHANNEL } from "./channel.ts";
import { type DiagnosticsContext, diagnosticsBundle, offerDiagnostics } from "./diagnostics.ts";
import { ErrorLog } from "./error-log.ts";
import { AttentionFeed } from "./feed.ts";
import { confineToAppScheme, hardenSession, openExternal } from "./hardening.ts";
import { LoginController } from "./login.ts";
import { launchesAtLogin, setLaunchAtLogin } from "./login-item.ts";
import { applyMenu } from "./menu.ts";
import { showNotification } from "./notify.ts";
import { checkServer, previewInvite } from "./server-client.ts";
import { SHELL_PARTITION, ShellUi } from "./shell-ui.ts";
import { ProfileStore } from "./store.ts";
import { type Connection, TrayController } from "./tray.ts";
import { UpdateController } from "./updates.ts";
import {
  CONNECT_PARTITION,
  createCockpitWindow,
  createConnectWindow,
  PATHS,
  partitionFor,
  reveal,
  setBadge,
} from "./windows.ts";
import { WorkspaceApi } from "./workspace-api.ts";

const PAUSE_MS = 60 * 60_000;

export class Shell {
  readonly errors = new ErrorLog(join(app.getPath("userData"), "errors.json"));
  private readonly store = new ProfileStore(
    join(app.getPath("userData"), "profiles.json"),
    (error) => this.errors.record("store", error),
  );
  private readonly login: LoginController;
  private readonly hardened = new Set<string>();
  private readonly pendingDevices = new Map<string, string>();
  private readonly feedbackListeners = new Set<number>();
  private tray: TrayController | null = null;
  private connectWindow: BrowserWindow | null = null;
  private cockpit: { window: BrowserWindow; profileId: string } | null = null;
  private pendingCapture: PendingCapture | null = null;
  private feed: AttentionFeed | null = null;
  private connection: Connection = "signed-out";
  private count = 0;
  private loginPhase: LoginPhase = { phase: "idle" };
  private notice: { kind: ConnectNotice; profileId: string } | null = null;
  private view: ConnectView = "connect";
  private signedIn: SignedIn | null = null;
  private tooOld: TooOldAsk | null = null;
  private onboarding: Onboarding = NO_ONBOARDING;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;

  private readonly updates = new UpdateController({
    onState: (state) => this.onUpdateState(state),
    onError: (scope, error) => this.errors.record(scope, error),
  });
  private offeredUpdate: string | null = null;
  private lastUpdate: UpdateState = { phase: "idle" };
  private workspace: WorkspaceApi | null = null;
  private shortcut: string | null = null;
  private readonly shellUi = new ShellUi({
    locale: () => this.locale(),
    online: () => this.connection === "online",
    workspace: () => this.workspaceApi(),
    cockpitWindow: () => this.cockpit?.window ?? null,
    openCockpit: (href) => this.open(href),
    reloadCockpit: () => {
      const window = this.cockpit?.window;
      if (window && !window.isDestroyed()) window.webContents.reload();
    },
    notify: (content, onClick) => showNotification(content, () => onClick()),
    openExternal: (url) => openExternal(url),
    onError: (scope, error) => this.errors.record(scope, error),
  });

  constructor() {
    this.login = new LoginController({
      sessionFor: (origin) => this.sessionFor(origin),
      deviceId: (origin) => this.deviceIdFor(origin),
      deviceLabel: () => hostname(),
      callback: () => loginCallback(CHANNEL.scheme),
      appVersion: () => app.getVersion(),
      onPhase: (phase) => this.onLoginPhase(phase),
      onSignedIn: (origin, descriptor, desktop) => this.onSignedIn(origin, descriptor, desktop),
      onError: (scope, error) => this.errors.record(scope, error),
    });
  }

  start(initialLink: string | null, hidden: boolean): void {
    this.store.load();
    this.store.update(dropPendingProfiles);
    const connectSession = session.fromPartition(CONNECT_PARTITION);
    hardenSession(connectSession, null);
    confineToAppScheme(connectSession);
    serveAppFiles(connectSession, PATHS.connectRoot);
    const shellSession = session.fromPartition(SHELL_PARTITION);
    hardenSession(shellSession, null);
    confineToAppScheme(shellSession);
    serveAppFiles(shellSession, PATHS.shellRoot);
    hardenSession(session.defaultSession, null);
    this.registerIpc();
    this.shellUi.registerIpc();
    this.tray = new TrayController(PATHS.assets, {
      open: () => this.open(),
      needsYou: () => this.open("/"),
      pause: () => void this.togglePause(),
      resume: () => void this.togglePause(),
      launchAtLogin: () => this.setLaunch(!this.store.data.settings.launchAtLogin),
      update: () => void this.checkUpdates(),
      quickCapture: () => this.shellUi.openCapture(),
      settings: () => this.showConnect("settings"),
      reportProblem: () => void this.reportProblem(),
      quit: () => this.quit(),
      dropFiles: (paths) => this.dropFiles(paths, "tray"),
    });
    nativeTheme.on("updated", () => this.shellUi.refresh());
    this.schedulePauseEnd();
    this.render();
    this.startFeed();
    if (initialLink) this.handleDeepLink(initialLink);
    else if (!hidden) this.open();
    void this.updates.start();
  }

  locale(): Locale {
    return resolveLocale(this.store.data.settings.locale, app.getLocale());
  }

  open(href?: string): void {
    const profile = activeProfile(this.store.data);
    if (isSignedIn(profile) && this.notice?.profileId !== profile.id)
      this.openCockpit(profile, href);
    else this.showConnect("connect");
  }

  handleDeepLink(raw: string): void {
    const link = parseDeepLink(raw, CHANNEL.scheme);
    if (!link) {
      this.errors.record("deep-link", new Error("ignored an unknown deep link"));
      this.open();
      return;
    }
    if (link.kind === "open") {
      this.open();
      return;
    }
    void this.login.handle(link).then((handled) => {
      if (!handled || this.loginPhase.phase === "failed") this.showConnect("connect");
    });
  }

  dropFiles(paths: string[], via: DropVia): void {
    const profile = activeProfile(this.store.data);
    if (!isSignedIn(profile)) {
      this.open();
      return;
    }
    void this.shellUi.openDrop(paths, via);
  }

  beforeQuit(): void {
    this.quitting = true;
    globalShortcut.unregisterAll();
    this.shellUi.closeAll();
    this.feed?.stop();
    this.store.flush();
  }

  quit(): void {
    this.beforeQuit();
    app.quit();
  }

  private sessionFor(origin: string) {
    const partition = partitionFor(profileIdFor(origin));
    const scoped = session.fromPartition(partition);
    if (!this.hardened.has(partition)) {
      this.hardened.add(partition);
      hardenSession(scoped, origin);
    }
    return scoped;
  }

  private deviceIdFor(origin: string): string {
    const id = profileIdFor(origin);
    const known = findProfile(this.store.data, id)?.deviceId ?? this.pendingDevices.get(id);
    if (known) return known;
    const created = randomUUID();
    this.pendingDevices.set(id, created);
    return created;
  }

  private onLoginPhase(phase: LoginPhase): void {
    this.loginPhase = phase;
    if (phase.phase === "failed") this.forgetUnusedSession(phase.origin);
    this.render();
  }

  private forgetUnusedSession(origin: string): void {
    const id = profileIdFor(origin);
    if (findProfile(this.store.data, id) || !this.hardened.has(partitionFor(id))) return;
    void session
      .fromPartition(partitionFor(id))
      .clearStorageData()
      .catch((error) => this.errors.record("session.clear", error));
  }

  private pauseSupport: PauseSupport = "unknown";
  private serverPause: NotificationPauseBody | null = null;
  private held: Held | null = null;

  private mute() {
    const { settings } = this.store.data;
    return trayMute({
      support: this.pauseSupport,
      server: this.serverPause,
      held: this.held,
      quietHours: settings.quietHours,
      localPauseUntil: settings.pauseUntil,
      now: Date.now(),
    });
  }

  private muted(): boolean {
    return this.mute() !== null;
  }

  private async loadPause(): Promise<void> {
    const api = this.workspaceApi();
    if (!api) return;
    try {
      const { status, json } = await api.send("GET", PAUSE_PATH);
      this.pauseSupport = pauseSupportOf(status) ?? this.pauseSupport;
      if (this.pauseSupport === "server") this.serverPause = parsePause(json) ?? this.serverPause;
    } catch (error) {
      this.errors.record("pause.read", error);
    }
    this.schedulePauseEnd();
    this.render();
  }

  private onStreamEvent(name: string, data: string): void {
    const finished = signInFinished(name, data);
    if (finished) this.shellUi.signInFinished(finished);
    const held = heldHint(data, Date.now());
    if (!held && name !== "hello" && name !== "ping" && !data.includes('"delivery"')) return;
    const changed = held?.by !== this.held?.by || held?.until !== this.held?.until;
    this.held = held;
    if (changed) void this.loadPause();
  }

  private profiles(): ProfileSummary[] {
    const { data } = this.store;
    return data.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      serverOrigin: profile.serverOrigin,
      signedIn: isSignedIn(profile),
      active: profile.id === data.activeProfileId,
    }));
  }

  private connectState(): ConnectState {
    const { settings } = this.store.data;
    const locale = this.locale();
    return {
      appVersion: app.getVersion(),
      deviceLabel: deviceLabel(hostname()),
      locale,
      messages: dictionary(locale),
      view: this.view,
      profiles: this.profiles(),
      settings: {
        locale: settings.locale,
        launchAtLogin: app.isPackaged ? launchesAtLogin() : settings.launchAtLogin,
        quietHours: settings.quietHours,
        notifications: settings.notifications,
        shareDiagnostics: settings.shareDiagnostics,
      },
      login: this.loginPhase,
      notice: this.notice,
      signedIn: this.signedIn,
      onboarding: this.onboarding,
      update: this.updates.current,
    };
  }

  private windows(): BrowserWindow[] {
    return [this.cockpit?.window, this.connectWindow].filter((window): window is BrowserWindow =>
      Boolean(window && !window.isDestroyed()),
    );
  }

  private render(): void {
    const locale = this.locale();
    const { settings } = this.store.data;
    const signedIn = isSignedIn(activeProfile(this.store.data));
    this.syncShortcut(signedIn);
    this.tray?.render({
      locale,
      count: this.count,
      connection: this.connection,
      mute: this.mute(),
      update: this.updateMenuItem(locale),
      quickCapture: signedIn ? quickCaptureAccelerator(process.platform) : null,
      launchAtLogin: { checked: settings.launchAtLogin, enabled: app.isPackaged },
    });
    applyMenu(
      { locale, profiles: this.profiles(), update: this.updateMenuItem(locale) },
      {
        settings: () => this.showConnect("settings"),
        addServer: () => this.showConnect("connect"),
        openProfile: (id) => this.activate(id),
        reportProblem: () => void this.reportProblem(),
        checkUpdates: () => void this.checkUpdates(),
        quit: () => this.quit(),
      },
    );
    setBadge(
      badgeLabel(this.count),
      t(locale, "tray.needsYou", { count: this.count }),
      this.windows(),
    );
    if (this.connectWindow && !this.connectWindow.isDestroyed()) {
      this.connectWindow.webContents.send(CONNECT_CHANNELS.state, this.connectState());
    }
    const cockpit = this.cockpit?.window;
    if (cockpit && !cockpit.isDestroyed()) {
      cockpit.webContents.send(COCKPIT_CHANNELS.statusChanged, this.cockpitStatus());
      cockpit.webContents.send(COCKPIT_CHANNELS.desktopSettingsChanged, this.desktopSettings());
    }
    this.shellUi.refresh();
  }

  private desktopSettings(): DesktopSettingsView {
    const { settings } = this.store.data;
    return {
      appVersion: app.getVersion(),
      launchAtLogin: app.isPackaged ? launchesAtLogin() : settings.launchAtLogin,
      launchAtLoginAvailable: app.isPackaged,
      shareDiagnostics: settings.shareDiagnostics,
      notifications: settings.notifications,
      update: desktopUpdateView(this.updates.current, app.getVersion(), (key, vars) =>
        t(this.locale(), key, vars),
      ),
    };
  }

  private changeSettings(input: Record<string, unknown>): void {
    const merged = parseSettings({ ...this.store.data.settings, ...input });
    const launch = merged.launchAtLogin !== this.store.data.settings.launchAtLogin;
    this.store.update((data) => ({
      ...data,
      settings: { ...merged, pauseUntil: data.settings.pauseUntil },
    }));
    if (launch) this.setLaunch(merged.launchAtLogin);
    else this.render();
  }

  private cockpitStatus() {
    return shellStatus(this.connection, this.updates.current, this.locale(), this.tooOld);
  }

  private syncShortcut(signedIn: boolean): void {
    const wanted = signedIn ? quickCaptureAccelerator(process.platform) : null;
    if (wanted === this.shortcut) return;
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = null;
    if (!wanted) return;
    try {
      if (globalShortcut.register(wanted, () => this.shellUi.openCapture())) this.shortcut = wanted;
      else this.errors.record("shortcut", new Error(`${wanted} is taken`));
    } catch (error) {
      this.errors.record("shortcut", error);
    }
  }

  private workspaceApi(): WorkspaceApi | null {
    const profile = activeProfile(this.store.data);
    if (!isSignedIn(profile)) return null;
    const target = { serverOrigin: profile.serverOrigin, cockpitPath: profile.cockpitPath };
    if (!this.workspace?.matches(target))
      this.workspace = new WorkspaceApi(this.sessionFor(profile.serverOrigin), target);
    return this.workspace;
  }

  private announce({ notification, target }: StatusNotification): void {
    if (this.muted() || !this.store.data.settings.notifications) return;
    showNotification(notification, () => this.openTarget(target));
  }

  private openTarget(target: ShellTarget): void {
    if (target === "settings") this.showConnect("settings");
    else if (target === "connect") this.showConnect("connect");
    else this.open();
  }

  private setConnection(next: Connection): void {
    const notice = statusNotice(this.connection, next);
    if (next === "online" && this.connection !== "online") {
      void this.loadPause();
      void this.checkCompatibility();
    }
    this.connection = next;
    if (notice) this.announce(statusNotification(notice, this.locale()));
  }

  private keepAlive(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
  }

  private showConnect(view: ConnectView): void {
    this.signedIn = null;
    this.onboarding = NO_ONBOARDING;
    this.revealConnect(view);
  }

  private revealConnect(view: ConnectView): void {
    this.view = view;
    if (!this.connectWindow || this.connectWindow.isDestroyed()) {
      const window = createConnectWindow();
      this.connectWindow = window;
      this.keepAlive(window);
      window.once("ready-to-show", () => reveal(window));
    } else reveal(this.connectWindow);
    this.render();
  }

  private openCockpit(profile: Profile & { cockpitPath: string }, href?: string): void {
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
      return;
    }
    this.sessionFor(profile.serverOrigin);
    const window = createCockpitWindow(profile, (url) => {
      if (!isConnectorSignIn(url, profile.serverOrigin)) return false;
      const page = window.isDestroyed() ? null : window.webContents.getURL();
      this.shellUi.openSheet(url, connectorIdFromPage(page));
      return true;
    });
    this.cockpit = { window, profileId: profile.id };
    this.keepAlive(window);
    window.once("ready-to-show", () => reveal(window));
    window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.errors.record("cockpit.load", new Error(`${code} ${description}`));
      this.notice = { kind: "offline", profileId: profile.id };
      this.closeCockpit();
      this.showConnect("connect");
    });
    const contentsId = window.webContents.id;
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.feedbackListeners.delete(contentsId);
    });
    window.on("closed", () => this.feedbackListeners.delete(contentsId));
    window.webContents.on("render-process-gone", (_event, details) => {
      this.errors.record("cockpit.renderer", new Error(details.reason));
      if (details.reason !== "clean-exit" && !window.isDestroyed()) window.webContents.reload();
    });
    void window.loadURL(target).catch(() => {});
    this.connectWindow?.hide();
    this.render();
  }

  private closeCockpit(): void {
    const window = this.cockpit?.window;
    this.cockpit = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private activate(id: string): void {
    const profile = findProfile(this.store.data, id);
    if (!profile) return;
    if (this.store.data.activeProfileId !== id) {
      this.store.update((data) => ({ ...data, activeProfileId: id }));
      this.count = 0;
      this.startFeed();
    }
    if (this.notice?.profileId === id && this.notice.kind === "offline") this.notice = null;
    this.render();
    this.open();
  }

  private startFeed(): void {
    this.feed?.stop();
    this.feed = null;
    this.tooOld = null;
    const profile = activeProfile(this.store.data);
    if (!isSignedIn(profile)) {
      this.connection =
        this.notice && this.notice.kind !== "offline" ? this.notice.kind : "signed-out";
      this.render();
      return;
    }
    const id = profile.id;
    const current = () => {
      const live = findProfile(this.store.data, id);
      return isSignedIn(live) && this.store.data.activeProfileId === id ? live : null;
    };
    this.connection = "connecting";
    this.feed = new AttentionFeed({
      session: this.sessionFor(profile.serverOrigin),
      profile: current,
      muted: () => this.muted(),
      saveProgress: (patch) =>
        this.store.update((data) => upsertProfile(data, profile.serverOrigin, patch), false),
      onItems: (items, notify, summary) => this.onItems(id, items, notify, summary),
      onStatus: (status) => {
        this.setConnection(status);
        if (
          status === "online" &&
          this.notice?.kind === "offline" &&
          this.notice.profileId === id
        ) {
          this.notice = null;
        }
        this.render();
      },
      onAuthFailure: (failure) => this.onAuthFailure(id, failure),
      onEvent: (name, data) => this.onStreamEvent(name, data),
      onError: (scope, error) => this.errors.record(scope, error),
    });
    this.feed.start();
    this.render();
  }

  private onItems(
    profileId: string,
    items: AttentionItem[],
    notify: AttentionItem[],
    summary: boolean,
  ): void {
    this.count = items.length;
    const locale = this.locale();
    for (const notification of this.store.data.settings.notifications
      ? toNotifications(notify, locale, summary)
      : []) {
      showNotification(notification, (href) => {
        const profile = findProfile(this.store.data, profileId);
        if (isSignedIn(profile) && this.store.data.activeProfileId === profileId) {
          this.openCockpit(profile, href ?? undefined);
        } else this.open();
      });
    }
    this.render();
  }

  private onAuthFailure(profileId: string, failure: AuthFailure): void {
    const profile = findProfile(this.store.data, profileId);
    if (!profile || !isSignedIn(profile)) return;
    const visible = Boolean(
      this.cockpit && !this.cockpit.window.isDestroyed() && this.cockpit.window.isVisible(),
    );
    this.feed?.stop();
    this.feed = null;
    this.count = 0;
    this.setConnection(failure);
    this.notice = { kind: failure, profileId };
    if (failure === "revoked") {
      this.store.update((data) => signOutProfile(data, profileId));
      void this.sessionFor(profile.serverOrigin)
        .clearStorageData()
        .catch((error) => this.errors.record("session.clear", error));
    } else {
      this.store.update((data) =>
        upsertProfile(data, profile.serverOrigin, { installationId: null, cockpitPath: null }),
      );
    }
    this.closeCockpit();
    if (visible) this.showConnect("connect");
    else this.render();
  }

  private onSignedIn(origin: string, descriptor: ServiceDescriptor, desktop: DesktopSession): void {
    const id = profileIdFor(origin);
    this.store.update((data) => ({
      ...upsertProfile(
        data,
        origin,
        {
          installationId: desktop.installationId,
          cockpitPath: desktop.cockpitPath,
          serverVersion: descriptor.version,
          feedbackPath: descriptor.desktop?.feedbackPath ?? null,
        },
        this.pendingDevices.get(id),
      ),
      activeProfileId: id,
    }));
    this.pendingDevices.delete(id);
    this.notice = null;
    this.count = 0;
    this.closeCockpit();
    this.startFeed();
    this.signedIn = { profileId: id, origin, serverVersion: descriptor.version };
    this.onboarding = LOADING_ONBOARDING;
    this.revealConnect("connect");
    void this.beginOnboarding().then(() => this.render());
  }

  private async beginOnboarding(): Promise<void> {
    let workspaces: WorkspaceOption[] = [];
    const api = this.workspaceApi();
    if (api) {
      try {
        const { status, json } = await api.send("GET", MEMBERSHIPS_PATH);
        if (status >= 200 && status < 300) workspaces = parseMemberships(json);
      } catch (error) {
        this.errors.record("onboarding.memberships", error);
      }
    }
    this.onboarding = startOnboarding(workspaces, this.store.data.settings);
  }

  private async chooseWorkspace(tenantId: string | null): Promise<void> {
    if (tenantId === null) {
      this.onboarding = completeStep(this.onboarding, "workspace");
      this.render();
      return;
    }
    if (!this.onboarding.workspaces.some((workspace) => workspace.tenantId === tenantId)) return;
    const api = this.workspaceApi();
    if (!api) return;
    try {
      const { status } = await api.send("POST", TENANT_SESSION_PATH, tenantSessionBody(tenantId));
      this.onboarding =
        status >= 200 && status < 300
          ? chooseWorkspace(this.onboarding, tenantId)
          : workspaceFailed(this.onboarding);
    } catch (error) {
      this.errors.record("onboarding.workspace", error);
      this.onboarding = workspaceFailed(this.onboarding);
    }
    this.render();
  }

  private answerNotifications(allow: boolean): void {
    this.store.update((data) => ({
      ...data,
      settings: { ...data.settings, notifications: allow, notificationsAsked: true },
    }));
    if (allow) {
      const locale = this.locale();
      showNotification(
        {
          id: "notifications-on",
          title: t(locale, "perm.test.title"),
          body: t(locale, "perm.test.body"),
          silent: false,
          urgency: "normal",
          href: null,
        },
        () => this.open(),
      );
    }
    this.onboarding = completeStep(this.onboarding, "notifications");
    this.render();
  }

  private answerDiagnostics(share: boolean): void {
    this.store.update((data) => ({
      ...data,
      settings: { ...data.settings, shareDiagnostics: share, diagnosticsAsked: true },
    }));
    this.onboarding = completeStep(this.onboarding, "diagnostics");
    this.render();
  }

  private async togglePause(): Promise<void> {
    const paused = this.mute()?.reason === "paused";
    const api = this.workspaceApi();
    if (this.pauseSupport === "server" && api) {
      const request = pauseToggle(paused);
      try {
        const { status, json } =
          request.method === "PUT"
            ? await api.send("PUT", PAUSE_PATH, JSON.stringify(request.body))
            : await api.send("DELETE", PAUSE_PATH);
        if (status >= 200 && status < 300) this.serverPause = parsePause(json) ?? this.serverPause;
        else this.errors.record("pause.write", new Error(`pause ${status}`));
      } catch (error) {
        this.errors.record("pause.write", error);
      }
      this.schedulePauseEnd();
      this.render();
      return;
    }
    this.store.update((data) => ({
      ...data,
      settings: { ...data.settings, pauseUntil: paused ? null : Date.now() + PAUSE_MS },
    }));
    this.schedulePauseEnd();
    this.render();
  }

  private schedulePauseEnd(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const until = this.mute()?.until?.getTime() ?? null;
    if (until === null || until <= Date.now() || until - Date.now() > 2 ** 31 - 1) return;
    this.pauseTimer = setTimeout(
      () => {
        this.schedulePauseEnd();
        this.render();
      },
      until - Date.now() + 500,
    );
  }

  private setLaunch(enabled: boolean): void {
    try {
      setLaunchAtLogin(enabled);
    } catch (error) {
      this.errors.record("login-item", error);
    }
    this.store.update((data) => ({
      ...data,
      settings: { ...data.settings, launchAtLogin: enabled },
    }));
    this.render();
  }

  private diagnosticsContext(profile: Profile | null): DiagnosticsContext {
    return {
      locale: this.locale(),
      serverOrigin: profile?.serverOrigin ?? null,
      serverVersion: profile?.serverVersion ?? null,
      connection: this.connection,
      profileCount: this.store.data.profiles.length,
      errors: this.errors.entries,
    };
  }

  private async reportProblem(): Promise<void> {
    const profile = activeProfile(this.store.data);
    if (isSignedIn(profile) && profile.feedbackPath) {
      const open = this.cockpit?.profileId === profile.id ? this.cockpit.window : null;
      const png = open ? await captureWindow(open) : null;
      this.pendingCapture = png ? { png, at: Date.now() } : null;
      if (open && !open.isDestroyed() && this.feedbackListeners.has(open.webContents.id)) {
        reveal(open);
        open.webContents.send(COCKPIT_CHANNELS.feedbackRequested);
        return;
      }
      this.openCockpit(profile, profile.feedbackPath);
      return;
    }
    await offerDiagnostics(
      this.windows()[0] ?? null,
      this.diagnosticsContext(profile ?? null),
    ).catch((error) => this.errors.record("diagnostics", error));
  }

  private async captureForCockpit(): Promise<string | null> {
    const pending = reusableCapture(this.pendingCapture, Date.now());
    this.pendingCapture = null;
    if (pending) return pending;
    const window = this.cockpit?.window;
    return window ? captureWindow(window) : null;
  }

  private updateMenuItem(locale: Locale): MenuUpdateItem | null {
    const state = this.updates.current;
    if (state.phase === "disabled") return null;
    const { key, vars } = updateMenuLabel(state);
    return { label: t(locale, key, vars), enabled: updateAction(state) !== null };
  }

  private onUpdateState(state: UpdateState): void {
    const version = updateNotice(this.lastUpdate, state);
    this.lastUpdate = state;
    if (version) this.announce(updateNotification(version, this.locale()));
    this.render();
    if (state.phase !== "ready" || this.offeredUpdate === state.version) return;
    this.offeredUpdate = state.version;
    void this.offerRestart(state.version);
  }

  private async checkUpdates(): Promise<void> {
    const action = updateAction(this.updates.current);
    if (action === "restart") {
      this.restartForUpdate();
      return;
    }
    this.showConnect("settings");
    if (action === "check") await this.updates.check();
  }

  private async updateFromCockpit(): Promise<void> {
    const action = updateAction(this.updates.current);
    if (action === "restart") this.restartForUpdate();
    else if (action === "check") await this.updates.check();
  }

  private restartForUpdate(): void {
    this.beforeQuit();
    if (!this.updates.restart()) this.quitting = false;
  }

  private async offerRestart(version: string): Promise<void> {
    const locale = this.locale();
    const choice = await dialog.showMessageBox({
      type: "info",
      message: t(locale, "updates.ready.title"),
      detail: t(locale, "updates.ready.body", { version }),
      buttons: [t(locale, "updates.restart"), t(locale, "updates.later")],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) this.restartForUpdate();
  }

  private async removeServer(id: string): Promise<void> {
    const profile = findProfile(this.store.data, id);
    if (!profile) return;
    const locale = this.locale();
    const options = {
      type: "warning" as const,
      message: t(locale, "profiles.remove.confirm", { name: profile.label }),
      detail: t(locale, "profiles.remove.detail"),
      buttons: [t(locale, "profiles.remove"), t(locale, "profiles.remove.cancel")],
      defaultId: 1,
      cancelId: 1,
    };
    const choice = this.connectWindow
      ? await dialog.showMessageBox(this.connectWindow, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) return;
    if (this.cockpit?.profileId === id) this.closeCockpit();
    if (this.notice?.profileId === id) this.notice = null;
    await this.sessionFor(profile.serverOrigin)
      .clearStorageData()
      .catch((error) => this.errors.record("session.clear", error));
    this.store.update((data) => removeProfile(data, id));
    this.count = 0;
    this.startFeed();
  }

  private async checkCompatibility(): Promise<void> {
    const profile = activeProfile(this.store.data);
    if (!isSignedIn(profile)) return;
    const check = await checkServer(
      profile.serverOrigin,
      app.getVersion(),
      loginCallback(CHANNEL.scheme),
    );
    if (activeProfile(this.store.data)?.id !== profile.id) return;
    if (check.result.status === "unreachable") return;
    this.tooOld = tooOldAsk(check.result);
    this.render();
  }

  private async checkInvite(raw: unknown): Promise<InviteCheck> {
    const link = typeof raw === "string" ? parseInviteLink(raw.slice(0, 2048)) : null;
    if (!link) return { kind: "link" };
    const check = await checkServer(link.origin, app.getVersion(), loginCallback(CHANNEL.scheme));
    if (check.result.status !== "compatible") return { kind: "server", result: check.result };
    const preview = await previewInvite(link);
    return preview
      ? { kind: "preview", preview }
      : { kind: "server", result: { ...check.result, status: "unreachable" } };
  }

  private joinInvite(raw: unknown): void {
    const link = typeof raw === "string" ? parseInviteLink(raw.slice(0, 2048)) : null;
    if (link) openExternal(invitePageUrl(link));
  }

  private async signIn(address: unknown): Promise<CheckResult> {
    const check = await checkServer(
      typeof address === "string" ? address.slice(0, 2048) : "",
      app.getVersion(),
      loginCallback(CHANNEL.scheme),
    );
    const { origin } = check.result;
    if (check.result.status === "compatible" && check.descriptor && origin) {
      await this.login.start(origin, check.descriptor);
    }
    return check.result;
  }

  private fromConnect(event: IpcMainInvokeEvent): boolean {
    const frame = event.senderFrame;
    return Boolean(
      this.connectWindow &&
        !this.connectWindow.isDestroyed() &&
        event.sender === this.connectWindow.webContents &&
        frame &&
        frame === event.sender.mainFrame &&
        isConnectUrl(frame.url),
    );
  }

  private fromCockpit(event: Electron.IpcMainEvent | IpcMainInvokeEvent): Profile | null {
    const frame = event.senderFrame;
    const profile = this.cockpit ? findProfile(this.store.data, this.cockpit.profileId) : null;
    if (!profile || !frame || event.sender !== this.cockpit?.window.webContents) return null;
    if (frame !== event.sender.mainFrame || !isSameOrigin(frame.url, profile.serverOrigin))
      return null;
    return profile;
  }

  private registerIpc(): void {
    const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>) => {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (!this.fromConnect(event)) throw new Error("Unexpected sender");
        return action(...args);
      });
    };
    handle(CONNECT_CHANNELS.getState, () => this.connectState());
    handle(CONNECT_CHANNELS.checkServer, async (address) => {
      const check = await checkServer(
        typeof address === "string" ? address.slice(0, 2048) : "",
        app.getVersion(),
        loginCallback(CHANNEL.scheme),
      );
      return check.result;
    });
    handle(CONNECT_CHANNELS.login, (address) => this.signIn(address));
    handle(CONNECT_CHANNELS.cancelLogin, () => this.login.cancel());
    handle(CONNECT_CHANNELS.openProfile, (id) => {
      if (typeof id !== "string") return;
      this.signedIn = null;
      this.onboarding = NO_ONBOARDING;
      this.activate(id);
    });
    handle(CONNECT_CHANNELS.removeProfile, async (id) => {
      if (typeof id === "string") await this.removeServer(id);
    });
    handle(CONNECT_CHANNELS.showView, (view) => {
      this.view = view === "settings" ? "settings" : "connect";
      this.render();
    });
    handle(CONNECT_CHANNELS.updateAction, () => this.checkUpdates());
    handle(CONNECT_CHANNELS.reportProblem, () => this.reportProblem());
    handle(CONNECT_CHANNELS.chooseWorkspace, (tenantId) =>
      this.chooseWorkspace(typeof tenantId === "string" && tenantId ? tenantId : null),
    );
    handle(CONNECT_CHANNELS.answerNotifications, (allow) =>
      this.answerNotifications(allow === true),
    );
    handle(CONNECT_CHANNELS.answerDiagnostics, (share) => this.answerDiagnostics(share === true));
    handle(CONNECT_CHANNELS.checkInvite, (link) => this.checkInvite(link));
    handle(CONNECT_CHANNELS.joinInvite, (link) => this.joinInvite(link));
    handle(CONNECT_CHANNELS.updateSettings, (patch) => {
      if (!patch || typeof patch !== "object") return;
      this.changeSettings(patch as Record<string, unknown>);
    });
    ipcMain.handle(COCKPIT_CHANNELS.desktopSettings, (event) =>
      this.fromCockpit(event) ? this.desktopSettings() : null,
    );
    ipcMain.handle(COCKPIT_CHANNELS.updateDesktopSettings, (event, patch: unknown) => {
      if (this.fromCockpit(event)) this.changeSettings({ ...desktopSettingsPatch(patch) });
    });
    ipcMain.handle(COCKPIT_CHANNELS.recheckServer, (event) =>
      this.fromCockpit(event) ? this.checkCompatibility() : undefined,
    );
    ipcMain.handle(COCKPIT_CHANNELS.runUpdateAction, (event) =>
      this.fromCockpit(event) ? this.updateFromCockpit() : undefined,
    );
    ipcMain.handle(COCKPIT_CHANNELS.diagnostics, (event) => {
      const profile = this.fromCockpit(event);
      return profile ? diagnosticsBundle(this.diagnosticsContext(profile)) : null;
    });
    ipcMain.handle(COCKPIT_CHANNELS.status, (event) =>
      this.fromCockpit(event) ? this.cockpitStatus() : null,
    );
    ipcMain.handle(COCKPIT_CHANNELS.captureWindow, (event) =>
      this.fromCockpit(event) ? this.captureForCockpit() : null,
    );
    ipcMain.on(COCKPIT_CHANNELS.feedbackListening, (event, listening: unknown) => {
      if (!this.fromCockpit(event)) return;
      if (listening === true) this.feedbackListeners.add(event.sender.id);
      else this.feedbackListeners.delete(event.sender.id);
    });
    ipcMain.on(COCKPIT_CHANNELS.sessionEnded, (event) => {
      if (this.fromCockpit(event)) this.feed?.refresh();
    });
    ipcMain.on(COCKPIT_CHANNELS.setLocale, (event, locale: unknown) => {
      if (!this.fromCockpit(event) || (locale !== "de" && locale !== "en")) return;
      this.store.update((data) => ({ ...data, settings: { ...data.settings, locale } }));
      this.render();
    });
  }
}
