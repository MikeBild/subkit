import type { MessageKey } from "../../shared/i18n.ts";
import type {
  CheckResult,
  CheckStatus,
  ConnectState,
  LoginPhase,
  ProfileSummary,
} from "../../shared/ipc.ts";
import {
  LAST_SETUP_STEP,
  type LocalErrorKind,
  type PhaseRow,
  setupComplete,
  setupRows,
} from "../../shared/local/local-workspace-model.ts";
import {
  PERMISSION_KEYS,
  type PermissionKey,
  permissionGranted,
  permissionsDone,
} from "../../shared/local/permission-model.ts";
import type { PermissionView } from "../../shared/local/permission-port.ts";
import type { DataFolderRefusal } from "../../shared/local/supervisor-model.ts";
import { currentStep, type WorkspaceOption } from "../../shared/onboarding.ts";
import { supports } from "../../shared/platform-capabilities.ts";
import type { ReportView } from "../../shared/problem-report.ts";
import { hostOf, isLoopbackHost } from "../../shared/server-address.ts";
import { REVOKED_CODE } from "../../shared/server-contract.ts";
import { type TooOldAsk, tooOldAsk } from "../../shared/server-too-old.ts";
import {
  CLOSED_INVITE,
  type Invitation,
  type InviteField,
  type InviteView,
  inviteView,
  type WelcomeInvite,
  welcomeInvite,
} from "./invite-model.ts";
import { SIGN_IN_ERRORS, type SignInErrorCase } from "./sign-in-errors.ts";

export { hostOf };

export type FlowStep = "welcome" | "invite" | "connect" | "signin" | "local";
export type FlowPath = "server" | "invite" | "create";
export type ConsentTopic = "notifications" | "diagnostics";

export interface FlowUi {
  step: FlowStep;
  path: FlowPath;
  address: string;
  target: { origin: string; serverVersion: string | null } | null;
  check: CheckSlot;
  reloginDismissed: boolean;
  localStep: number;
  invite: InviteField;
  invitation: Invitation | null;
  consent: Record<ConsentTopic, boolean | null>;
}

export type CheckSlot =
  | { phase: "idle" }
  | { phase: "checking"; requestId: number }
  | { phase: "done"; result: CheckResult }
  | { phase: "failed" };

export const INITIAL_FLOW: FlowUi = {
  step: "welcome",
  path: "server",
  address: "",
  target: null,
  check: { phase: "idle" },
  reloginDismissed: false,
  localStep: 0,
  invite: CLOSED_INVITE,
  invitation: null,
  consent: { notifications: null, diagnostics: null },
};

export interface Fact {
  label: MessageKey;
  value: string;
}

export type NoticeAction =
  | { kind: "recheck" }
  | { kind: "sign-in"; origin: string }
  | { kind: "open-profile"; profileId: string };

export interface Problem {
  tone: "warning" | "danger";
  title: MessageKey;
  body: MessageKey;
  vars: Record<string, string>;
  meta: string;
  error: SignInErrorCase;
  facts: Fact[];
  ask: TooOldAsk | null;
  example: string | null;
}

export type Outcome =
  | { kind: "idle" }
  | { kind: "ok"; version: string | null }
  | { kind: "problem"; problem: Problem };

export type SlotModel = { kind: "checking" } | { kind: "outcome"; outcome: Outcome };

export interface StripModel {
  tone: "warning" | "danger";
  title: MessageKey;
  vars: Record<string, string>;
  action: { label: MessageKey; action: NoticeAction } | null;
  body?: MessageKey;
  facts?: Fact[];
}

export type SignInModel =
  | { phase: "ready" }
  | { phase: "waiting" }
  | { phase: "exchanging" }
  | { phase: "done"; serverVersion: string | null }
  | { phase: "failed"; strip: StripModel; error: SignInErrorCase; facts: Fact[] };

export interface LocalSetupModel {
  kind: "local";
  step: number;
  starting: boolean;
  folder: string;
  folderRefusal: DataFolderRefusal | null;
  rows: PhaseRow[];
  error: LocalErrorKind | null;
  working: boolean;
  done: boolean;
}

export type Screen =
  | { kind: "settings" }
  | { kind: "report"; report: ReportView }
  | { kind: "permissions"; setup: PermissionSetupModel }
  | { kind: "local-capabilities"; device: string; signedIn: boolean; supported: boolean }
  | LocalSetupModel
  | { kind: "welcome"; invite: WelcomeInvite }
  | { kind: "invite"; invite: InviteView }
  | {
      kind: "connect";
      address: string;
      checking: boolean;
      strip: StripModel | null;
      fieldError: MessageKey | null;
      slot: SlotModel;
      examples: string[];
      canContinue: boolean;
      localAvailable: boolean;
      localMacOnly: boolean;
      back: boolean;
    }
  | { kind: "signin"; origin: string; host: string; signin: SignInModel; hint: MessageKey | null }
  | {
      kind: "signed-in";
      profileId: string;
      host: string;
      serverVersion: string | null;
      device: string;
    }
  | { kind: "relogin"; origin: string; host: string; signin: SignInModel }
  | { kind: "workspace"; workspaces: WorkspaceOption[]; failed: boolean }
  | { kind: "consent"; topic: ConsentTopic; choice: boolean | null };

const FIELD_PROBLEMS = new Set<CheckStatus>(["empty", "invalid", "insecure", "credentials"]);

function loopback(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function exampleAddresses(
  profiles: ProfileSummary[],
  defaultServer: string | null = null,
): string[] {
  const seen = new Set<string>(defaultServer ? [hostOf(defaultServer)] : []);
  const out: string[] = [];
  for (const profile of profiles) {
    const address = hostOf(profile.serverOrigin);
    if (seen.has(address) || loopback(profile.serverOrigin)) continue;
    seen.add(address);
    out.push(address);
  }
  return out.slice(0, 3);
}

export function fieldError(check: CheckSlot): MessageKey | null {
  if (check.phase !== "done" || !FIELD_PROBLEMS.has(check.result.status)) return null;
  return `field.${check.result.status as "empty" | "invalid" | "insecure" | "credentials"}`;
}

export function factsFor(error: SignInErrorCase, origin: string | null): Fact[] {
  const code: Fact = { label: "err.code", value: SIGN_IN_ERRORS[error].code };
  return origin ? [code, { label: "err.url", value: origin }] : [code];
}

function exampleFor(host: string, defaultServer: string | null): string | null {
  return defaultServer && hostOf(defaultServer) !== host ? defaultServer : null;
}

function problem(
  error: SignInErrorCase,
  title: "slot.unreachable" | "slot.not-subkit" | "slot.app-too-old" | "slot.login-unsupported",
  origin: string | null,
  meta: string,
  extra: Fact[] = [],
  defaultServer: string | null = null,
): Problem {
  const danger = error === "serverUnreachable" || error === "notSubkit";
  return {
    tone: danger ? "danger" : "warning",
    title,
    body: `${title}.help`,
    vars: {},
    meta,
    error,
    facts: [...factsFor(error, origin), ...extra],
    ask: null,
    example: danger ? exampleFor(meta, defaultServer) : null,
  };
}

function typedHost(address: string): string {
  return hostOf(address.trim()) || address.trim();
}

export function slotFor(
  check: CheckSlot,
  appVersion: string,
  address = "",
  defaultServer: string | null = null,
): SlotModel {
  if (check.phase === "checking") return { kind: "checking" };
  if (check.phase === "idle") return { kind: "outcome", outcome: { kind: "idle" } };
  if (check.phase === "failed") {
    const meta = typedHost(address);
    return {
      kind: "outcome",
      outcome: {
        kind: "problem",
        problem: problem("serverUnreachable", "slot.unreachable", null, meta, [], defaultServer),
      },
    };
  }
  const { result } = check;
  if (FIELD_PROBLEMS.has(result.status)) return { kind: "outcome", outcome: { kind: "idle" } };
  const tried = result.origin;
  const meta = tried ? hostOf(tried) : typedHost(address);
  const outcome = ((): Outcome => {
    switch (result.status) {
      case "compatible":
        return { kind: "ok", version: result.serverVersion };
      case "server-too-old": {
        const ask = tooOldAsk(result);
        return {
          kind: "problem",
          problem: {
            tone: "warning",
            title: "notice.server-too-old",
            body: "notice.server-too-old.body",
            vars: { version: ask?.version ?? "?", needs: ask?.needs ?? "" },
            meta,
            error: "serverTooOld",
            facts: factsFor("serverTooOld", tried),
            ask,
            example: null,
          },
        };
      }
      case "app-too-old":
        return {
          kind: "problem",
          problem: problem("appTooOld", "slot.app-too-old", tried, meta, [
            { label: "err.app", value: appVersion },
            { label: "err.needs", value: result.minAppVersion ?? "?" },
          ]),
        };
      case "login-unsupported":
        return {
          kind: "problem",
          problem: problem("loginUnsupported", "slot.login-unsupported", tried, meta),
        };
      case "not-subkit":
        return {
          kind: "problem",
          problem: problem("notSubkit", "slot.not-subkit", tried, meta, [], defaultServer),
        };
      default:
        return {
          kind: "problem",
          problem: problem("serverUnreachable", "slot.unreachable", tried, meta, [], defaultServer),
        };
    }
  })();
  return { kind: "outcome", outcome };
}

type FailedReason = Extract<LoginPhase, { phase: "failed" }>["reason"];

const SIGN_IN_FAILURES: Record<FailedReason, SignInErrorCase> = {
  cancelled: "signinCancelled",
  expired: "signinExpired",
  rejected: "signinRejected",
  outdated: "signinOutdated",
  unreachable: "signinUnreachable",
  "browser-failed": "browserFailed",
};

export function signInFor(login: LoginPhase, origin: string): SignInModel {
  if (login.phase === "idle" || login.origin !== origin) return { phase: "ready" };
  if (login.phase === "waiting") return { phase: "waiting" };
  if (login.phase === "exchanging") return { phase: "exchanging" };
  const reason: FailedReason = login.reason;
  const error = SIGN_IN_FAILURES[reason];
  return {
    phase: "failed",
    strip: {
      tone: reason === "cancelled" || reason === "outdated" ? "warning" : "danger",
      title: `signin.failed.${reason}`,
      vars: {},
      action: null,
    },
    error,
    facts: reason === "cancelled" ? [] : factsFor(error, null),
  };
}

function profileStrip(state: ConnectState): StripModel | null {
  const { notice } = state;
  if (!notice || notice.kind === "expired") return null;
  const profile = state.profiles.find((candidate) => candidate.id === notice.profileId);
  const host = profile ? hostOf(profile.serverOrigin) : "";
  if (notice.kind === "revoked") {
    return {
      tone: "warning",
      title: "strip.revoked",
      vars: { host },
      body: "strip.revoked.body",
      facts: [
        { label: "err.code", value: REVOKED_CODE },
        ...(profile ? [{ label: "err.url" as const, value: profile.serverOrigin }] : []),
      ],
      action: profile
        ? {
            label: "strip.revoked.action",
            action: { kind: "sign-in", origin: profile.serverOrigin },
          }
        : null,
    };
  }
  return {
    tone: "danger",
    title: "strip.offline",
    vars: { host },
    action: { label: "err.retry", action: { kind: "open-profile", profileId: notice.profileId } },
  };
}

export function signInHint(path: FlowPath, signin: SignInModel): MessageKey | null {
  if (path === "create")
    return signin.phase === "ready" || signin.phase === "waiting" ? "signin.create" : null;
  if (path === "invite") return signin.phase === "waiting" ? "signin.join" : null;
  return null;
}

export function reloginOrigin(state: ConnectState, ui: FlowUi): string | null {
  const { notice } = state;
  if (notice?.kind !== "expired" || ui.reloginDismissed || ui.step !== "connect") return null;
  return state.profiles.find((profile) => profile.id === notice.profileId)?.serverOrigin ?? null;
}

export function welcomeAvailable(state: ConnectState): boolean {
  return state.profiles.length === 0 && !state.signedIn && !state.notice;
}

export function forcedStep(state: ConnectState, ui: FlowUi): FlowUi {
  const { login } = state;
  if (login.phase === "waiting" || login.phase === "exchanging") {
    if (reloginOrigin(state, ui) === login.origin) return ui;
    if (ui.step === "signin" && ui.target?.origin === login.origin) return ui;
    return {
      ...ui,
      step: "signin",
      target: { origin: login.origin, serverVersion: ui.target?.serverVersion ?? null },
    };
  }
  if (ui.step === "welcome" && !welcomeAvailable(state)) return { ...ui, step: "connect" };
  if (ui.step !== "local") return ui;
  const { error } = state.local;
  if (error === "folder" && ui.localStep > 0) return { ...ui, localStep: 0 };
  if (error === "keyRejected" && ui.localStep > 2) return { ...ui, localStep: 2 };
  return ui;
}

export interface PermissionCard {
  key: PermissionKey;
  granted: boolean;
  restart: boolean;
}

export interface PermissionSetupModel {
  supported: boolean;
  cards: PermissionCard[];
  done: boolean;
  lost: boolean;
}

export function permissionSetupFor(view: PermissionView): PermissionSetupModel {
  const { permissions } = view;
  return {
    supported: view.supported,
    cards: PERMISSION_KEYS.map((key) => ({
      key,
      granted: permissionGranted(permissions, key),
      restart: key === "screen" && permissions.restartPending,
    })),
    done: permissionsDone(permissions),
    lost: view.lost.length > 0,
  };
}

export function localScreenFor(state: ConnectState, ui: FlowUi): LocalSetupModel | null {
  const { local } = state;
  const setup = ui.step === "local";
  if (!setup && !local.attention) return null;
  const done = setupComplete(local.progress);
  return {
    kind: "local",
    step: setup ? Math.min(ui.localStep, LAST_SETUP_STEP) : LAST_SETUP_STEP,
    starting: !setup,
    folder: local.folder,
    folderRefusal: local.folderRefusal,
    rows: setupRows(local.progress, local.working && local.error === null),
    error: local.error,
    working: local.working,
    done,
  };
}

export function screenFor(state: ConnectState, ui: FlowUi): Screen {
  if (state.view === "settings") return { kind: "settings" };
  if (state.view === "report") return { kind: "report", report: state.report };
  if (state.view === "local")
    return {
      kind: "local-capabilities",
      device: state.deviceLabel,
      signedIn: Boolean(state.signedIn),
      supported: supports(state.platform, "files"),
    };
  if (state.view === "permissions")
    return { kind: "permissions", setup: permissionSetupFor(state.permissions) };
  const local = localScreenFor(state, ui);
  if (local) return local;
  if (state.signedIn && state.onboarding.loading) {
    const { origin, serverVersion } = state.signedIn;
    return {
      kind: "signin",
      origin,
      host: hostOf(origin),
      signin: { phase: "done", serverVersion },
      hint: null,
    };
  }
  const onboarding = currentStep(state.onboarding);
  if (state.signedIn && onboarding) {
    if (onboarding === "workspace")
      return {
        kind: "workspace",
        workspaces: state.onboarding.workspaces,
        failed: state.onboarding.failed,
      };
    return { kind: "consent", topic: onboarding, choice: ui.consent[onboarding] };
  }
  if (state.signedIn) {
    return {
      kind: "signed-in",
      profileId: state.signedIn.profileId,
      host: hostOf(state.signedIn.origin),
      serverVersion: state.signedIn.serverVersion,
      device: state.deviceLabel,
    };
  }
  const relogin = reloginOrigin(state, ui);
  if (relogin) {
    return {
      kind: "relogin",
      origin: relogin,
      host: hostOf(relogin),
      signin: signInFor(state.login, relogin),
    };
  }
  if (ui.step === "signin" && ui.target) {
    const { origin } = ui.target;
    const signin = signInFor(state.login, origin);
    return {
      kind: "signin",
      origin,
      host: hostOf(origin),
      signin,
      hint: signInHint(ui.path, signin),
    };
  }
  if (ui.step === "invite" && ui.invitation) {
    return { kind: "invite", invite: inviteView(ui.invitation, state.locale) };
  }
  if (ui.step === "welcome" && welcomeAvailable(state)) {
    return { kind: "welcome", invite: welcomeInvite(ui.invite) };
  }
  const slot = slotFor(ui.check, state.appVersion, ui.address, state.defaultServer);
  return {
    kind: "connect",
    address: ui.address,
    checking: ui.check.phase === "checking",
    strip: profileStrip(state),
    fieldError: fieldError(ui.check),
    slot,
    examples: exampleAddresses(state.profiles, state.defaultServer),
    canContinue: slot.kind === "outcome" && slot.outcome.kind === "ok",
    back: welcomeAvailable(state),
    localAvailable: state.local.available && !state.local.configured,
    localMacOnly: !supports(state.platform, "localWorkspace"),
  };
}
