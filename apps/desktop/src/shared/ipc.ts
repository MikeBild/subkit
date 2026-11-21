import type { FolderAccess } from "@shared/device/boundary.ts";
import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { Locale, LocaleSetting, MessageKey } from "./i18n.ts";
import type { InviteCheck } from "./invite-link.ts";
import type { AllowancesView } from "./local/files-allowances.ts";
import type {
  AiAccessInput,
  BackupRow,
  LocalErrorKind,
  LocalProgress,
} from "./local/local-workspace-model.ts";
import type { PermissionKey } from "./local/permission-model.ts";
import type { PermissionView } from "./local/permission-port.ts";
import type { DataFolderRefusal } from "./local/supervisor-model.ts";
import type { Onboarding } from "./onboarding.ts";
import type { QuietHours } from "./quiet-hours.ts";
import type { AddressProblem } from "./server-address.ts";
import type { AuthFailure, ExchangeFailure } from "./server-contract.ts";
import type { ShellStatus } from "./status-model.ts";
import { type UpdateState, updateAction, updateStatus } from "./updates.ts";
import type { Compatibility } from "./version.ts";

export const CONNECT_CHANNELS = {
  getState: "connect:get-state",
  checkServer: "connect:check-server",
  login: "connect:login",
  cancelLogin: "connect:cancel-login",
  openProfile: "connect:open-profile",
  removeProfile: "connect:remove-profile",
  updateSettings: "connect:update-settings",
  showView: "connect:show-view",
  updateAction: "connect:update-action",
  reportProblem: "connect:report-problem",
  checkPermissions: "connect:check-permissions",
  openPermissionSettings: "connect:open-permission-settings",
  restartApp: "connect:restart-app",
  localPickDataFolder: "connect:local-pick-data-folder",
  localBegin: "connect:local-begin",
  localFinish: "connect:local-finish",
  localCancel: "connect:local-cancel",
  localOpen: "connect:local-open",
  localBackup: "connect:local-backup",
  localRestore: "connect:local-restore",
  localMove: "connect:local-move",
  localRemoveAll: "connect:local-remove-all",
  chooseWorkspace: "connect:choose-workspace",
  answerNotifications: "connect:answer-notifications",
  answerDiagnostics: "connect:answer-diagnostics",
  checkInvite: "connect:check-invite",
  joinInvite: "connect:join-invite",
  state: "connect:state",
  localPickFolder: "connect:local-pick-folder",
  localListAllowances: "connect:local-list-allowances",
  localRemoveAllowance: "connect:local-remove-allowance",
  localSetAccess: "connect:local-set-access",
  localSetPersonalEnabled: "connect:local-set-personal-enabled",
  localAddSite: "connect:local-add-site",
  localAddApp: "connect:local-add-app",
} as const;

export const COCKPIT_CHANNELS = {
  sessionEnded: "cockpit:session-ended",
  setLocale: "cockpit:set-locale",
  diagnostics: "cockpit:diagnostics",
  captureWindow: "cockpit:capture-window",
  feedbackListening: "cockpit:feedback-listening",
  feedbackRequested: "cockpit:feedback-requested",
  status: "cockpit:status",
  statusChanged: "cockpit:status-changed",
  desktopSettings: "cockpit:desktop-settings",
  updateDesktopSettings: "cockpit:update-desktop-settings",
  runUpdateAction: "cockpit:run-update-action",
  recheckServer: "cockpit:recheck-server",
  desktopSettingsChanged: "cockpit:desktop-settings-changed",
  openLocalCapabilities: "cockpit:open-local-capabilities",
} as const;

export const BRIDGE_PROTOCOL_VERSION = 7;

export interface BridgeCapabilities {
  screenshot: { optIn: boolean; masksSecretFields: boolean; masksVisibleText: boolean };
}

export const BRIDGE_CAPABILITIES: BridgeCapabilities = {
  screenshot: { optIn: true, masksSecretFields: true, masksVisibleText: false },
};

export type CheckStatus = Compatibility | "unreachable" | "not-subkit" | AddressProblem;

export interface CheckResult {
  status: CheckStatus;
  origin: string | null;
  serverVersion: string | null;
  minAppVersion: string | null;
  minServerVersion: string;
}

export type LoginPhase =
  | { phase: "idle" }
  | { phase: "waiting"; origin: string }
  | { phase: "exchanging"; origin: string }
  | { phase: "failed"; origin: string; reason: ExchangeFailure | "cancelled" | "browser-failed" };

export type ConnectNotice = AuthFailure | "offline";

export interface ProfileSummary {
  id: string;
  label: string;
  serverOrigin: string;
  signedIn: boolean;
  active: boolean;
}

export interface SettingsView {
  locale: LocaleSetting;
  launchAtLogin: boolean;
  quietHours: QuietHours;
  notifications: boolean;
  shareDiagnostics: boolean;
}

export const CONNECT_VIEWS = ["connect", "settings", "local", "permissions"] as const;
export type ConnectView = (typeof CONNECT_VIEWS)[number];

export function isConnectView(value: unknown): value is ConnectView {
  return (CONNECT_VIEWS as readonly unknown[]).includes(value);
}

export interface SignedIn {
  profileId: string;
  origin: string;
  serverVersion: string | null;
}

export type LocalBusy = "backup" | "restore" | "move" | "remove";

export interface LocalMoved {
  server: string;
  bundle: string;
}

export interface LocalView {
  available: boolean;
  configured: boolean;
  attention: boolean;
  folder: string;
  folderRefusal: DataFolderRefusal | null;
  progress: LocalProgress;
  working: boolean;
  error: LocalErrorKind | null;
  backups: BackupRow[];
  sizeBytes: number | null;
  busy: LocalBusy | null;
  moved: LocalMoved | null;
  aiConfigured: boolean;
  modelTools: boolean | null;
}

export const LOCAL_UNAVAILABLE: LocalView = {
  available: false,
  configured: false,
  attention: false,
  folder: "",
  folderRefusal: null,
  progress: { database: false, engine: false, workspace: false },
  working: false,
  error: null,
  backups: [],
  sizeBytes: null,
  busy: null,
  moved: null,
  aiConfigured: false,
  modelTools: null,
};

export interface LocalFinishInput {
  name: string;
  ai: AiAccessInput | null;
}

export interface ConnectState {
  appVersion: string;
  deviceLabel: string;
  locale: Locale;
  messages: Record<MessageKey, string>;
  view: ConnectView;
  profiles: ProfileSummary[];
  settings: SettingsView;
  login: LoginPhase;
  notice: { kind: ConnectNotice; profileId: string } | null;
  signedIn: SignedIn | null;
  onboarding: Onboarding;
  update: UpdateState;
  permissions: PermissionView;
  local: LocalView;
}

export interface SettingsPatch {
  locale?: LocaleSetting;
  launchAtLogin?: boolean;
  quietHours?: QuietHours;
  notifications?: boolean;
  shareDiagnostics?: boolean;
}

export interface PickFolderOptions {
  access?: FolderAccess;
  keepOut?: boolean;
}

export type PickFolderResult =
  | { status: "cancelled" }
  | { status: "refused"; code: string }
  | { status: "added"; id: string; view: AllowancesView };

export interface LocalBridge {
  pickFolder(options?: PickFolderOptions): Promise<PickFolderResult>;
  listAllowances(): Promise<AllowancesView>;
  removeAllowance(id: string): Promise<AllowancesView>;
  setAccess(id: string, access: FolderAccess): Promise<AllowancesView>;
  setPersonalEnabled(enabled: boolean): Promise<AllowancesView>;
  addSite(origin: string): Promise<AllowancesView>;
  addApp(): Promise<PickFolderResult>;
}

export interface ConnectBridge {
  local: LocalBridge;
  getState(): Promise<ConnectState>;
  checkServer(address: string): Promise<CheckResult>;
  login(address: string): Promise<CheckResult>;
  cancelLogin(): Promise<void>;
  openProfile(id: string): Promise<void>;
  removeProfile(id: string): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  showView(view: ConnectView): Promise<void>;
  updateAction(): Promise<void>;
  reportProblem(): Promise<void>;
  checkPermissions(): Promise<void>;
  openPermissionSettings(key: PermissionKey): Promise<void>;
  restartApp(): Promise<void>;
  localPickDataFolder(): Promise<void>;
  localBegin(): Promise<void>;
  localFinish(input: LocalFinishInput): Promise<void>;
  localCancel(): Promise<void>;
  localOpen(): Promise<void>;
  localBackup(): Promise<void>;
  localRestore(name: string): Promise<void>;
  localMove(serverOrigin: string): Promise<void>;
  localRemoveAll(): Promise<void>;
  chooseWorkspace(tenantId: string): Promise<void>;
  answerNotifications(allow: boolean): Promise<void>;
  answerDiagnostics(share: boolean): Promise<void>;
  checkInvite(link: string): Promise<InviteCheck>;
  joinInvite(link: string): Promise<void>;
  onState(listener: (state: ConnectState) => void): void;
}

export interface DesktopSettingsView {
  appVersion: string;
  launchAtLogin: boolean;
  launchAtLoginAvailable: boolean;
  shareDiagnostics: boolean;
  notifications: boolean;
  update: DesktopUpdateView;
}

export interface DesktopUpdateView {
  line: string;
  progress: number | null;
  action: { label: string; primary: boolean; enabled: boolean } | null;
}

export function desktopUpdateView(
  state: UpdateState,
  appVersion: string,
  translate: (key: MessageKey, vars?: Record<string, string | number>) => string,
): DesktopUpdateView {
  const status = updateStatus(state, appVersion);
  const action = updateAction(state);
  return {
    line: translate(status.key, status.vars),
    progress: state.phase === "downloading" ? state.percent : null,
    action:
      state.phase === "disabled"
        ? null
        : {
            label: translate(action === "restart" ? "updates.restart" : "tray.checkUpdates"),
            primary: action === "restart",
            enabled: action !== null,
          },
  };
}

export interface DesktopSettingsPatch {
  launchAtLogin?: boolean;
  shareDiagnostics?: boolean;
  notifications?: boolean;
}

export function desktopSettingsPatch(input: unknown): DesktopSettingsPatch {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  return {
    ...(typeof raw.launchAtLogin === "boolean" ? { launchAtLogin: raw.launchAtLogin } : {}),
    ...(typeof raw.shareDiagnostics === "boolean"
      ? { shareDiagnostics: raw.shareDiagnostics }
      : {}),
    ...(typeof raw.notifications === "boolean" ? { notifications: raw.notifications } : {}),
  };
}

export interface CockpitBridge {
  protocolVersion: number;
  platform: string;
  capabilities: BridgeCapabilities;
  onFeedbackRequested(listener: () => void): () => void;
  sessionEnded(): void;
  setLocale(locale: string): void;
  diagnostics(): Promise<DesktopDiagnostics | null>;
  captureWindow(): Promise<string | null>;
  status(): Promise<ShellStatus | null>;
  onStatus(listener: (status: ShellStatus) => void): () => void;
  desktopSettings(): Promise<DesktopSettingsView | null>;
  updateDesktopSettings(patch: DesktopSettingsPatch): Promise<void>;
  runUpdateAction(): Promise<void>;
  recheckServer(): Promise<void>;
  onDesktopSettings(listener: (settings: DesktopSettingsView) => void): () => void;
  openLocalCapabilities(): Promise<void>;
}
