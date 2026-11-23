import { DEFAULT_SERVER } from "../../src/shared/app-identity.ts";
import { openSheet } from "../../src/shared/browser-sheet-model.ts";
import { openDrop, reduceDrop } from "../../src/shared/drop-model.ts";
import { dictionary, type Locale } from "../../src/shared/i18n.ts";
import type { InviteCheck } from "../../src/shared/invite-link.ts";
import { type CheckResult, type ConnectState, LOCAL_UNAVAILABLE } from "../../src/shared/ipc.ts";
import {
  completeStep,
  LOADING_ONBOARDING,
  NO_ONBOARDING,
  startOnboarding,
} from "../../src/shared/onboarding.ts";
import { platformCapabilities } from "../../src/shared/platform-capabilities.ts";
import { CLOSED_REPORT, type ReportView } from "../../src/shared/problem-report.ts";
import { INITIAL_CAPTURE } from "../../src/shared/quick-capture-model.ts";
import { DEFAULT_QUIET_HOURS } from "../../src/shared/quiet-hours.ts";
import type { ShellState, ShellView } from "../../src/shared/shell-ipc.ts";

export interface Scenario {
  name: string;
  view: ShellView;
  patch: Partial<ShellState>;
}

const file = (name: string, size: number) => ({ name, size });
const drop = openDrop(
  [file("Angebot-Q4.pdf", 245_760), file("Meeting-Notizen.md", 3_400), file("Logo.png", 88_000)],
  "dock",
);
const authorize =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=subkit&state=x";
const reauth = (() => {
  const sheet = openSheet(authorize, "google-workspace");
  return sheet && { ...sheet, connectorName: "Google Workspace" };
})();

export const SCENARIOS: Scenario[] = [
  { name: "capture", view: "capture", patch: {} },
  { name: "capture-offline", view: "capture", patch: { online: false } },
  {
    name: "capture-sent",
    view: "capture",

    patch: { capture: { phase: "sent", itemId: "x" } },
  },
  {
    name: "capture-failed",
    view: "capture",

    patch: { capture: { phase: "failed", itemId: null } },
  },
  { name: "drop", view: "drop", patch: { drop } },
  {
    name: "drop-placing",
    view: "drop",

    patch: { drop: drop && reduceDrop(drop, { type: "place", choice: "file" }) },
  },
  { name: "drop-offline", view: "drop", patch: { drop, online: false } },
  { name: "sheet", view: "sheet", patch: { sheet: reauth } },
  {
    name: "sheet-succeeded",
    view: "sheet",
    patch: {
      sheet: reauth && { ...reauth, phase: "succeeded" as const },
    },
  },
  {
    name: "sheet-failed",
    view: "sheet",

    patch: {
      sheet: reauth && { ...reauth, phase: "failed" as const, reason: "token_exchange_failed" },
    },
  },
];

export function scenarioState(scenario: Scenario, locale: Locale, dark: boolean): ShellState {
  return {
    view: scenario.view,
    locale,
    platform: "darwin",
    dark,
    messages: dictionary(locale),
    online: true,
    capture: INITIAL_CAPTURE,
    drop: null,
    sheet: null,
    ...scenario.patch,
  };
}

const SERVER = "https://subkit.example.com";
const PROFILE = {
  id: "p1",
  label: "Bild Consulting",
  serverOrigin: SERVER,
  signedIn: false,
  active: true,
};

const SIGNED_IN = { profileId: PROFILE.id, origin: SERVER, serverVersion: "11.2.0" };
const FIRST_RUN = startOnboarding(
  [
    { tenantId: "t1", name: "Bild Consulting", role: "admin", owner: true },
    { tenantId: "t2", name: "Harmoniqs", role: "member", owner: false },
  ],
  { notificationsAsked: false, diagnosticsAsked: false },
);

export type PreviewStep = { click: string } | { type: string; into: string };

export interface ConnectScenario {
  name: string;
  patch: Partial<ConnectState>;
  steps?: PreviewStep[];
  check?: CheckResult;
  invite?: InviteCheck;
}

const START: PreviewStep = { click: "welcome-start" };
const INVITE_LINK = "https://subkit.example.com/cockpit/invite#wf_invite_Q2hhbmdlTWUxMjM0NTY3";
const OPEN_INVITE: PreviewStep[] = [
  { click: "welcome-invite" },
  { type: INVITE_LINK, into: "welcome-invite-link" },
  { click: "welcome-invite-open" },
];
const check = (address: string): PreviewStep[] => [
  START,
  { type: address, into: "connect-address" },
  { click: "connect-check" },
];
const SIGNED_IN_PROFILE = { profiles: [{ ...PROFILE, signedIn: true }], signedIn: SIGNED_IN };
const COMPLETED = { profiles: [{ ...PROFILE, signedIn: true }], signedIn: null };
const CONNECTED = {
  profiles: [
    {
      ...PROFILE,
      label: "Bild Consulting",
      serverOrigin: "https://subkit-cloud.mikebild.dev",
      signedIn: true,
      serverVersion: "12.1.5",
    },
  ],
  signedIn: null,
};
const SCREEN_MISSING = {
  supported: true,
  permissions: { accessibility: true, screen: false, restartPending: false },
  lost: [],
};

const REPORT_OPEN: ReportView = {
  ...CLOSED_REPORT,
  host: "subkit-cloud.mikebild.dev",
  preview: [
    { label: "report.fact.app", value: "12.1.5" },
    { label: "report.fact.system", value: "darwin 25.1.0" },
    { label: "report.fact.server", value: "12.1.5" },
    { label: "report.fact.errors", value: "2" },
    { label: "report.fact.log", value: "200" },
  ],
};

export const CONNECT_SCENARIOS: ConnectScenario[] = [
  { name: "welcome", patch: {} },
  {
    name: "welcome-invite-link",
    patch: {},
    steps: [{ click: "welcome-invite" }, { type: INVITE_LINK, into: "welcome-invite-link" }],
  },
  {
    name: "welcome-invite-invalid",
    patch: {},
    steps: [
      { click: "welcome-invite" },
      { type: "https://subkit.example.com/cockpit", into: "welcome-invite-link" },
      { click: "welcome-invite-open" },
    ],
  },
  {
    name: "invite-valid",
    patch: {},
    steps: OPEN_INVITE,
    invite: {
      kind: "preview",
      preview: {
        status: "valid",
        origin: SERVER,
        workspace: "Harmoniqs",
        invitedBy: "Anna Schmidt",
        emailHint: "m•••@bild.consulting",
        expiresAt: "2026-11-27T12:00:00.000Z",
      },
    },
  },
  {
    name: "invite-signin",
    patch: {},
    steps: [...OPEN_INVITE, { click: "invite-next" }],
    invite: {
      kind: "preview",
      preview: {
        status: "valid",
        origin: SERVER,
        workspace: "Harmoniqs",
        invitedBy: "Anna Schmidt",
        emailHint: "m•••@bild.consulting",
        expiresAt: "2026-11-27T12:00:00.000Z",
      },
    },
  },
  {
    name: "invite-expired",
    patch: {},
    steps: OPEN_INVITE,
    invite: { kind: "preview", preview: { status: "expired", origin: SERVER } },
  },
  { name: "connect", patch: {}, steps: [START] },
  {
    name: "server-unreachable",
    patch: {},
    steps: check("unknown.example.org"),
    check: {
      status: "unreachable",
      origin: "https://unknown.example.org",
      serverVersion: null,
      minAppVersion: null,
      minServerVersion: "11.0.0",
    },
  },
  {
    name: "session-expired",
    patch: { profiles: [PROFILE], notice: { kind: "expired", profileId: PROFILE.id } },
  },
  {
    name: "device-revoked",
    patch: { profiles: [PROFILE], notice: { kind: "revoked", profileId: PROFILE.id } },
  },
  {
    name: "server-too-old",
    patch: {},
    steps: check("old.example.com"),
    check: {
      status: "server-too-old",
      origin: "https://old.example.com",
      serverVersion: "9.2.0",
      minAppVersion: null,
      minServerVersion: "11.0.0",
    },
  },
  {
    name: "signed-in-done",
    patch: { ...SIGNED_IN_PROFILE, onboarding: LOADING_ONBOARDING },
  },
  {
    name: "workspace-choice",
    patch: { ...SIGNED_IN_PROFILE, onboarding: FIRST_RUN },
  },
  {
    name: "notification-permission",
    patch: { ...SIGNED_IN_PROFILE, onboarding: completeStep(FIRST_RUN, "workspace") },
  },
  {
    name: "notification-allowed",
    patch: { ...SIGNED_IN_PROFILE, onboarding: completeStep(FIRST_RUN, "workspace") },
    steps: [{ click: "first-run-notifications-on" }],
  },
  {
    name: "diagnostics-consent",
    patch: {
      ...SIGNED_IN_PROFILE,
      onboarding: completeStep(completeStep(FIRST_RUN, "workspace"), "notifications"),
    },
  },
  {
    name: "device-registered",
    patch: SIGNED_IN_PROFILE,
  },
  { name: "connected", patch: CONNECTED },
  {
    name: "connected-offline",
    patch: { ...CONNECTED, notice: { kind: "offline", profileId: PROFILE.id } },
  },
  { name: "connected-other-server", patch: CONNECTED, steps: [{ click: "server-other" }] },
  { name: "settings", patch: { ...COMPLETED, view: "settings" } },
  { name: "settings-first-run", patch: { view: "settings" } },
  { name: "local-capabilities", patch: { ...COMPLETED, view: "local" } },
  {
    name: "local-capabilities-from-settings",
    patch: { ...COMPLETED, view: "settings" },
    steps: [{ click: "settings-local-open" }],
  },
  { name: "permissions-missing", patch: { ...COMPLETED, view: "permissions" } },
  {
    name: "permissions-screen-missing",
    patch: { ...COMPLETED, view: "permissions", permissions: SCREEN_MISSING },
  },
  { name: "report", patch: { view: "report", report: REPORT_OPEN } },
  {
    name: "report-sent",
    patch: {
      view: "report",
      report: { ...REPORT_OPEN, phase: "sent", reference: "0f6c2e1a-6d0b-4c55-9a4e-3b1f2a7d8c90" },
    },
  },
  {
    name: "report-failed",
    patch: {
      view: "report",
      report: {
        ...REPORT_OPEN,
        phase: "failed",
        failure: "unavailable",
        reference: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    },
  },
];

export function connectState(scenario: ConnectScenario, locale: Locale): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook Pro",
    locale,
    messages: dictionary(locale),
    view: "connect",
    profiles: [],
    settings: {
      locale: "system",
      launchAtLogin: true,
      quietHours: DEFAULT_QUIET_HOURS,
      notifications: true,
      shareDiagnostics: false,
    },
    login: { phase: "idle" },
    notice: null,
    signedIn: null,
    onboarding: NO_ONBOARDING,
    update: { phase: "idle" },
    permissions: {
      supported: true,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    defaultServer: DEFAULT_SERVER,
    report: CLOSED_REPORT,
    ...scenario.patch,
  };
}
