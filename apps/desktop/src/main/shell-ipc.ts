import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { isConnectUrl } from "../shared/app-url.ts";
import type { DesktopDiagnostics } from "../shared/diagnostics.ts";
import type { InviteCheck } from "../shared/invite-link.ts";
import {
  type CheckResult,
  COCKPIT_CHANNELS,
  CONNECT_CHANNELS,
  type ConnectState,
  type ConnectView,
  clipboardText,
  type DesktopSettingsView,
  isConnectView,
  type ReportInput,
  reportInput,
} from "../shared/ipc.ts";
import { isPermissionKey, type PermissionKey } from "../shared/local/permission-model.ts";
import type { Profile } from "../shared/profiles.ts";
import { isSameOrigin } from "../shared/server-address.ts";
import type { ShellStatus } from "../shared/status-model.ts";
import type { LocalAllowances } from "./local-allowances.ts";
import { type IpcHandle, registerLocalIpc } from "./local-ipc.ts";

export interface ShellIpcHost {
  connectWindow(): BrowserWindow | null;
  cockpit(): { window: BrowserWindow; profile: Profile | null } | null;
  connectState(): ConnectState;
  checkServer(address: unknown): Promise<CheckResult>;
  signIn(address: unknown): Promise<CheckResult>;
  cancelLogin(): unknown;
  openProfile(id: string): void;
  removeServer(id: string): Promise<void>;
  showView(view: ConnectView): void;
  checkPermissions(): Promise<void>;
  openPermissionSettings(key: PermissionKey): Promise<void>;
  restartApp(): void;
  checkUpdates(): Promise<void>;
  reportProblem(): Promise<void>;
  submitReport(input: ReportInput): Promise<void>;
  saveDiagnostics(): Promise<void>;
  updateSettings(input: Record<string, unknown>): void;
  diagnostics(profile: Profile): Promise<DesktopDiagnostics>;
  copyDiagnostics(): Promise<void>;
  copyText(text: string): boolean;
  openLogs(): Promise<void>;
  cockpitStatus(): ShellStatus;
  captureForCockpit(): Promise<string | null>;
  feedbackListening(senderId: number, listening: boolean): void;
  sessionEnded(): void;
  setLocale(locale: "de" | "en"): void;
  chooseWorkspace(tenantId: string | null): Promise<void>;
  answerNotifications(allow: boolean): void;
  answerDiagnostics(share: boolean): void;
  checkInvite(link: unknown): Promise<InviteCheck>;
  joinInvite(link: unknown): Promise<CheckResult | null>;
  recheckServer(): Promise<void>;
  desktopSettings(): DesktopSettingsView;
  updateDesktopSettings(patch: unknown): void;
  runUpdateAction(): Promise<void>;
  readonly allowances: LocalAllowances;
  registerWorkspaceIpc(handle: IpcHandle): void;
}

function fromConnect(host: ShellIpcHost, event: IpcMainInvokeEvent): boolean {
  const window = host.connectWindow();
  const frame = event.senderFrame;
  return Boolean(
    window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      frame &&
      frame === event.sender.mainFrame &&
      isConnectUrl(frame.url),
  );
}

function fromCockpit(
  host: ShellIpcHost,
  event: Electron.IpcMainEvent | IpcMainInvokeEvent,
): Profile | null {
  const frame = event.senderFrame;
  const cockpit = host.cockpit();
  const profile = cockpit?.profile ?? null;
  if (!profile || !frame || event.sender !== cockpit?.window.webContents) return null;
  if (frame !== event.sender.mainFrame || !isSameOrigin(frame.url, profile.serverOrigin))
    return null;
  return profile;
}

export function registerShellIpc(host: ShellIpcHost): void {
  const handle = <T>(channel: string, action: (...args: unknown[]) => T | Promise<T>) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!fromConnect(host, event)) throw new Error("Unexpected sender");
      return action(...args);
    });
  };
  handle(CONNECT_CHANNELS.getState, () => host.connectState());
  handle(CONNECT_CHANNELS.checkServer, (address) => host.checkServer(address));
  handle(CONNECT_CHANNELS.login, (address) => host.signIn(address));
  handle(CONNECT_CHANNELS.cancelLogin, () => host.cancelLogin());
  handle(CONNECT_CHANNELS.openProfile, (id) => {
    if (typeof id === "string") host.openProfile(id);
  });
  handle(CONNECT_CHANNELS.removeProfile, async (id) => {
    if (typeof id === "string") await host.removeServer(id);
  });
  handle(CONNECT_CHANNELS.showView, (view) =>
    host.showView(isConnectView(view) ? view : "connect"),
  );
  handle(CONNECT_CHANNELS.checkPermissions, () => host.checkPermissions());
  handle(CONNECT_CHANNELS.openPermissionSettings, async (key) => {
    if (isPermissionKey(key)) await host.openPermissionSettings(key);
  });
  handle(CONNECT_CHANNELS.restartApp, () => host.restartApp());
  handle(CONNECT_CHANNELS.updateAction, () => host.checkUpdates());
  handle(CONNECT_CHANNELS.reportProblem, () => host.reportProblem());
  handle(CONNECT_CHANNELS.copyDiagnostics, () => host.copyDiagnostics());
  handle(CONNECT_CHANNELS.copyText, (text) => {
    const allowed = clipboardText(text);
    return allowed === null ? false : host.copyText(allowed);
  });
  handle(CONNECT_CHANNELS.saveDiagnostics, () => host.saveDiagnostics());
  handle(CONNECT_CHANNELS.submitReport, (input) => host.submitReport(reportInput(input)));
  handle(CONNECT_CHANNELS.openLogs, () => host.openLogs());
  registerLocalIpc(handle, host.allowances, () => host.connectWindow());
  host.registerWorkspaceIpc(handle);
  handle(CONNECT_CHANNELS.chooseWorkspace, (tenantId) =>
    host.chooseWorkspace(typeof tenantId === "string" && tenantId ? tenantId : null),
  );
  handle(CONNECT_CHANNELS.answerNotifications, (allow) => host.answerNotifications(allow === true));
  handle(CONNECT_CHANNELS.answerDiagnostics, (share) => host.answerDiagnostics(share === true));
  handle(CONNECT_CHANNELS.checkInvite, (link) => host.checkInvite(link));
  handle(CONNECT_CHANNELS.joinInvite, (link) => host.joinInvite(link));
  handle(CONNECT_CHANNELS.updateSettings, (patch) => {
    if (!patch || typeof patch !== "object") return;
    host.updateSettings(patch as Record<string, unknown>);
  });
  ipcMain.handle(COCKPIT_CHANNELS.desktopSettings, (event) =>
    fromCockpit(host, event) ? host.desktopSettings() : null,
  );
  ipcMain.handle(COCKPIT_CHANNELS.updateDesktopSettings, (event, patch: unknown) => {
    if (fromCockpit(host, event)) host.updateDesktopSettings(patch);
  });
  ipcMain.handle(COCKPIT_CHANNELS.recheckServer, (event) =>
    fromCockpit(host, event) ? host.recheckServer() : undefined,
  );
  ipcMain.handle(COCKPIT_CHANNELS.runUpdateAction, (event) =>
    fromCockpit(host, event) ? host.runUpdateAction() : undefined,
  );
  ipcMain.handle(COCKPIT_CHANNELS.openLocalCapabilities, (event) => {
    if (fromCockpit(host, event)) host.showView("local");
  });
  ipcMain.handle(COCKPIT_CHANNELS.diagnostics, (event) => {
    const profile = fromCockpit(host, event);
    return profile ? host.diagnostics(profile) : null;
  });
  ipcMain.handle(COCKPIT_CHANNELS.status, (event) =>
    fromCockpit(host, event) ? host.cockpitStatus() : null,
  );
  ipcMain.handle(COCKPIT_CHANNELS.captureWindow, (event) =>
    fromCockpit(host, event) ? host.captureForCockpit() : null,
  );
  ipcMain.on(COCKPIT_CHANNELS.feedbackListening, (event, listening: unknown) => {
    if (fromCockpit(host, event)) host.feedbackListening(event.sender.id, listening === true);
  });
  ipcMain.on(COCKPIT_CHANNELS.sessionEnded, (event) => {
    if (fromCockpit(host, event)) host.sessionEnded();
  });
  ipcMain.on(COCKPIT_CHANNELS.setLocale, (event, locale: unknown) => {
    if (!fromCockpit(host, event) || (locale !== "de" && locale !== "en")) return;
    host.setLocale(locale);
  });
}
