import type { Locale, LocaleSetting, MessageKey } from "./i18n.ts";
import type { QuietHours } from "./quiet-hours.ts";
import type { DesktopDiagnostics } from "./redaction.ts";
import type { AddressProblem } from "./server-address.ts";
import type { AuthFailure, ExchangeFailure } from "./server-contract.ts";
import type { UpdateState } from "./updates.ts";
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
  state: "connect:state",
} as const;

export const COCKPIT_CHANNELS = {
  sessionEnded: "cockpit:session-ended",
  setLocale: "cockpit:set-locale",
  diagnostics: "cockpit:diagnostics",
  captureWindow: "cockpit:capture-window",
  feedbackListening: "cockpit:feedback-listening",
  feedbackRequested: "cockpit:feedback-requested",
} as const;

export const BRIDGE_PROTOCOL_VERSION = 3;

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
}

export type ConnectView = "connect" | "settings";

export interface ConnectState {
  appVersion: string;
  locale: Locale;
  messages: Record<MessageKey, string>;
  view: ConnectView;
  profiles: ProfileSummary[];
  settings: SettingsView;
  login: LoginPhase;
  notice: { kind: ConnectNotice; profileId: string } | null;
  update: UpdateState;
}

export interface SettingsPatch {
  locale?: LocaleSetting;
  launchAtLogin?: boolean;
  quietHours?: QuietHours;
}

export interface ConnectBridge {
  getState(): Promise<ConnectState>;
  checkServer(address: string): Promise<CheckResult>;
  login(address: string): Promise<CheckResult>;
  cancelLogin(): Promise<void>;
  openProfile(id: string): Promise<void>;
  removeProfile(id: string): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  showView(view: ConnectView): Promise<void>;
  updateAction(): Promise<void>;
  onState(listener: (state: ConnectState) => void): void;
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
}
