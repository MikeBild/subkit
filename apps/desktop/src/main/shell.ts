import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  session,
} from "electron";
import { isConnectUrl } from "../shared/app-url.ts";
import { type AttentionItem, badgeLabel, toNotifications } from "../shared/attention.ts";
import { type PendingCapture, reusableCapture } from "../shared/capture.ts";
import { loginCallback } from "../shared/channel.ts";
import { parseDeepLink } from "../shared/deep-link.ts";
import { dictionary, type Locale, resolveLocale, t } from "../shared/i18n.ts";
import {
  type CheckResult,
  COCKPIT_CHANNELS,
  CONNECT_CHANNELS,
  type ConnectNotice,
  type ConnectState,
  type ConnectView,
  type LoginPhase,
  type ProfileSummary,
} from "../shared/ipc.ts";
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
import { muteReason } from "../shared/quiet-hours.ts";
import { cockpitUrl, isSameOrigin } from "../shared/server-address.ts";
import type { AuthFailure, DesktopSession, ServiceDescriptor } from "../shared/server-contract.ts";
import type { MenuUpdateItem } from "../shared/tray-model.ts";
import { type UpdateState, updateAction, updateMenuLabel } from "../shared/updates.ts";
import { serveAppFiles } from "./app-protocol.ts";
import { captureWindow } from "./capture.ts";
import { CHANNEL } from "./channel.ts";
import { type DiagnosticsContext, diagnosticsBundle, offerDiagnostics } from "./diagnostics.ts";
import { ErrorLog } from "./error-log.ts";
import { AttentionFeed } from "./feed.ts";
import { confineToAppScheme, hardenSession } from "./hardening.ts";
import { LoginController } from "./login.ts";
import { launchesAtLogin, setLaunchAtLogin } from "./login-item.ts";
import { applyMenu } from "./menu.ts";
import { showNotification } from "./notify.ts";
import { checkServer } from "./server-client.ts";
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
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;

  private readonly updates = new UpdateController({
    onState: (state) => this.onUpdateState(state),
    onError: (scope, error) => this.errors.record(scope, error),
  });
  private offeredUpdate: string | null = null;

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
    hardenSession(session.defaultSession, null);
    this.registerIpc();
    this.tray = new TrayController(PATHS.assets, {
      open: () => this.open(),
      openAttention: () => this.open("/"),
      togglePause: () => this.togglePause(),
      toggleLaunchAtLogin: () => this.setLaunch(!this.store.data.settings.launchAtLogin),
      reportProblem: () => void this.reportProblem(),
      checkUpdates: () => void this.checkUpdates(),
      quit: () => this.quit(),
    });
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

  beforeQuit(): void {
    this.quitting = true;
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

  private muted(): boolean {
    return muteReason(this.store.data.settings, new Date()) !== null;
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
      locale,
      messages: dictionary(locale),
      view: this.view,
      profiles: this.profiles(),
      settings: {
        locale: settings.locale,
        launchAtLogin: app.isPackaged ? launchesAtLogin() : settings.launchAtLogin,
        quietHours: settings.quietHours,
      },
      login: this.loginPhase,
      notice: this.notice,
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
    const paused = settings.pauseUntil !== null && settings.pauseUntil > Date.now();
    this.tray?.render({
      locale,
      count: this.count,
      connection: this.connection,
      paused,
      launchAtLogin: settings.launchAtLogin,
      update: this.updateMenuItem(locale),
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
  }

  private keepAlive(window: BrowserWindow): void {
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
  }

  private showConnect(view: ConnectView): void {
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
    const window = createCockpitWindow(profile);
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
        this.connection = status;
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
    for (const notification of toNotifications(notify, locale, summary)) {
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
    this.connection = failure;
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
    this.open();
  }

  private togglePause(): void {
    const paused = (this.store.data.settings.pauseUntil ?? 0) > Date.now();
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
    const until = this.store.data.settings.pauseUntil;
    if (until === null || until <= Date.now()) return;
    this.pauseTimer = setTimeout(() => this.render(), until - Date.now() + 500);
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
      if (typeof id === "string") this.activate(id);
    });
    handle(CONNECT_CHANNELS.removeProfile, async (id) => {
      if (typeof id === "string") await this.removeServer(id);
    });
    handle(CONNECT_CHANNELS.showView, (view) => {
      this.view = view === "settings" ? "settings" : "connect";
      this.render();
    });
    handle(CONNECT_CHANNELS.updateAction, () => this.checkUpdates());
    handle(CONNECT_CHANNELS.updateSettings, (patch) => {
      if (!patch || typeof patch !== "object") return;
      const input = patch as Record<string, unknown>;
      const merged = parseSettings({ ...this.store.data.settings, ...input });
      const launch = merged.launchAtLogin !== this.store.data.settings.launchAtLogin;
      this.store.update((data) => ({
        ...data,
        settings: { ...merged, pauseUntil: data.settings.pauseUntil },
      }));
      if (launch) this.setLaunch(merged.launchAtLogin);
      else this.render();
    });
    ipcMain.handle(COCKPIT_CHANNELS.diagnostics, (event) => {
      const profile = this.fromCockpit(event);
      return profile ? diagnosticsBundle(this.diagnosticsContext(profile)) : null;
    });
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
