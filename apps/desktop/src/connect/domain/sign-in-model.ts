import type { InviteCheck } from "../../shared/invite-link.ts";
import type {
  CheckResult,
  ConnectState,
  ConnectView,
  LocalFinishInput,
  SettingsPatch,
} from "../../shared/ipc.ts";
import { LAST_SETUP_STEP } from "../../shared/local/local-workspace-model.ts";
import type { PermissionKey } from "../../shared/local/permission-model.ts";
import { CLOSED_INVITE, inviteLinkOf } from "./invite-model.ts";
import {
  type ConsentTopic,
  type FlowStep,
  type FlowUi,
  forcedStep,
  INITIAL_FLOW,
  type NoticeAction,
  type Screen,
  screenFor,
} from "./screens-model.ts";
import { type FrameModel, frameFor } from "./steps-model.ts";

export interface SignInState {
  main: ConnectState | null;
  flow: FlowUi;
}

export const INITIAL_STATE: SignInState = { main: null, flow: INITIAL_FLOW };

export type Command =
  | { type: "EditAddress"; address: string }
  | { type: "CheckServer"; address: string }
  | { type: "ContinueToSignIn" }
  | { type: "StartSignIn"; origin: string }
  | { type: "CancelSignIn" }
  | { type: "GoBack" }
  | { type: "ConnectAnotherServer" }
  | { type: "OpenSubKit" }
  | { type: "OpenServer"; profileId: string }
  | { type: "SignInToServer"; profileId: string }
  | { type: "RemoveServer"; profileId: string }
  | { type: "ActOnNotice"; action: NoticeAction }
  | { type: "ToggleSettings" }
  | { type: "OpenLocalCapabilities" }
  | { type: "OpenPermissions" }
  | { type: "ChangeSettings"; patch: SettingsPatch }
  | { type: "RunUpdateAction" }
  | { type: "ReportProblem" }
  | { type: "CheckPermissions" }
  | { type: "OpenPermissionSettings"; key: PermissionKey }
  | { type: "RestartApp" }
  | { type: "ClosePermissions" }
  | { type: "StartLocalSetup" }
  | { type: "LocalPickDataFolder" }
  | { type: "LocalNext" }
  | { type: "LocalBack" }
  | { type: "LocalFinish"; input: LocalFinishInput }
  | { type: "LocalRetry" }
  | { type: "LocalOpen" }
  | { type: "LocalBackup" }
  | { type: "LocalRestore"; name: string }
  | { type: "LocalMove"; serverOrigin: string }
  | { type: "LocalMoveSignIn"; origin: string }
  | { type: "LocalRemoveAll" }
  | { type: "ChooseWorkspace"; tenantId: string }
  | { type: "KeepWorkspace" }
  | { type: "StartConnect" }
  | { type: "CreateWorkspace" }
  | { type: "ToggleInvite" }
  | { type: "EditInvite"; link: string }
  | { type: "OpenInvite" }
  | { type: "JoinInvite" }
  | { type: "ChooseConsent"; give: boolean }
  | { type: "ConfirmConsent" };

export type Event =
  | { type: "AddressEdited"; address: string }
  | { type: "VersionCheckStarted"; address: string; requestId: number }
  | { type: "VersionChecked"; requestId: number; result: CheckResult }
  | { type: "VersionCheckFailed"; requestId: number }
  | { type: "SignInTargetChosen"; origin: string; serverVersion: string | null }
  | { type: "SignInRefused"; result: CheckResult }
  | { type: "WentBack"; to: FlowStep }
  | { type: "ReloginDismissed" }
  | { type: "ConnectStarted"; path: "server" | "create" }
  | { type: "InviteToggled" }
  | { type: "InviteEdited"; link: string }
  | { type: "InviteRejected" }
  | { type: "InviteCheckStarted"; requestId: number }
  | { type: "InviteChecked"; requestId: number; link: string; check: InviteCheck }
  | { type: "InviteCheckFailed"; requestId: number; link: string }
  | { type: "InviteJoined"; origin: string }
  | { type: "ConsentChosen"; topic: ConsentTopic; give: boolean }
  | { type: "MainStateReceived"; state: ConnectState }
  | { type: "LocalSetupOpened" }
  | { type: "LocalStepChanged"; step: number };

export type Effect =
  | { kind: "checkServer"; address: string; requestId: number }
  | { kind: "login"; origin: string }
  | { kind: "cancelLogin" }
  | { kind: "openProfile"; profileId: string }
  | { kind: "removeProfile"; profileId: string }
  | { kind: "showView"; view: ConnectView }
  | { kind: "updateSettings"; patch: SettingsPatch }
  | { kind: "updateAction" }
  | { kind: "reportProblem" }
  | { kind: "checkPermissions" }
  | { kind: "openPermissionSettings"; key: PermissionKey }
  | { kind: "restartApp" }
  | { kind: "localPickDataFolder" }
  | { kind: "localBegin" }
  | { kind: "localFinish"; input: LocalFinishInput }
  | { kind: "localCancel" }
  | { kind: "localOpen" }
  | { kind: "localBackup" }
  | { kind: "localRestore"; name: string }
  | { kind: "localMove"; serverOrigin: string }
  | { kind: "localRemoveAll" }
  | { kind: "chooseWorkspace"; tenantId: string }
  | { kind: "answerNotifications"; allow: boolean }
  | { kind: "answerDiagnostics"; share: boolean }
  | { kind: "checkInvite"; link: string; requestId: number }
  | { kind: "joinInvite"; link: string };

export interface Decision {
  events: Event[];
  effects: Effect[];
}

export interface DecideContext {
  requestId: number;
}

const NOTHING: Decision = { events: [], effects: [] };

function only(...effects: Effect[]): Decision {
  return { events: [], effects };
}

function check(state: SignInState, address: string, requestId: number): Decision {
  if (state.flow.check.phase === "checking") return NOTHING;
  return {
    events: [{ type: "VersionCheckStarted", address, requestId }],
    effects: [{ kind: "checkServer", address, requestId }],
  };
}

export function screenOf(state: SignInState): Screen | null {
  return state.main ? screenFor(state.main, state.flow) : null;
}

function backStep(state: SignInState, screen: Screen | null): FlowStep {
  if (screen?.kind === "invite" || screen?.kind === "connect") return "welcome";
  if (screen?.kind === "signin" && state.flow.path === "invite" && state.flow.invitation)
    return "invite";
  return "connect";
}

function openInvite(state: SignInState, requestId: number): Decision {
  const { invite } = state.flow;
  if (invite.slot.phase === "checking") return NOTHING;
  if (!inviteLinkOf(invite.link)) return { events: [{ type: "InviteRejected" }], effects: [] };
  return {
    events: [{ type: "InviteCheckStarted", requestId }],
    effects: [{ kind: "checkInvite", link: invite.link, requestId }],
  };
}

function confirmConsent(screen: Screen | null): Decision {
  if (screen?.kind !== "consent" || screen.choice === null) return NOTHING;
  return screen.topic === "notifications"
    ? only({ kind: "answerNotifications", allow: screen.choice })
    : only({ kind: "answerDiagnostics", share: screen.choice });
}

export function decide(state: SignInState, command: Command, context: DecideContext): Decision {
  const screen = screenOf(state);
  switch (command.type) {
    case "EditAddress":
      return { events: [{ type: "AddressEdited", address: command.address }], effects: [] };
    case "CheckServer":
      return check(state, command.address, context.requestId);
    case "ContinueToSignIn": {
      const slot = state.flow.check;
      if (screen?.kind !== "connect" || !screen.canContinue || slot.phase !== "done") {
        return NOTHING;
      }
      const { origin, serverVersion } = slot.result;
      if (!origin) return NOTHING;
      return { events: [{ type: "SignInTargetChosen", origin, serverVersion }], effects: [] };
    }
    case "StartSignIn":
      return only({ kind: "login", origin: command.origin });
    case "CancelSignIn":
      return only({ kind: "cancelLogin" });
    case "GoBack": {
      if (screen?.kind === "settings" || screen?.kind === "permissions")
        return only({ kind: "showView", view: "connect" });
      if (screen?.kind === "local-capabilities")
        return only({ kind: "showView", view: "settings" });
      if (screen?.kind === "local") return decideLocal(state, { type: "LocalBack" });
      const waiting = screen?.kind === "signin" && screen.signin.phase === "waiting";
      return {
        events: [{ type: "WentBack", to: backStep(state, screen) }],
        effects: waiting ? [{ kind: "cancelLogin" }] : [],
      };
    }
    case "ConnectAnotherServer":
      return { events: [{ type: "ReloginDismissed" }], effects: [] };
    case "OpenSubKit":
      return screen?.kind === "signed-in"
        ? only({ kind: "openProfile", profileId: screen.profileId })
        : NOTHING;
    case "OpenServer":
      return only({ kind: "openProfile", profileId: command.profileId });
    case "SignInToServer": {
      const profile = state.main?.profiles.find((item) => item.id === command.profileId);
      if (!profile) return NOTHING;
      return {
        events: [{ type: "SignInTargetChosen", origin: profile.serverOrigin, serverVersion: null }],
        effects: [{ kind: "showView", view: "connect" }],
      };
    }
    case "RemoveServer":
      return only({ kind: "removeProfile", profileId: command.profileId });
    case "ActOnNotice": {
      const { action } = command;
      if (action.kind === "recheck") return check(state, state.flow.address, context.requestId);
      if (action.kind === "sign-in") return only({ kind: "login", origin: action.origin });
      return only({ kind: "openProfile", profileId: action.profileId });
    }
    case "ToggleSettings":
      return only({
        kind: "showView",
        view:
          state.main?.view === "settings" || state.main?.view === "local" ? "connect" : "settings",
      });
    case "OpenLocalCapabilities":
      return screen?.kind === "settings" ? only({ kind: "showView", view: "local" }) : NOTHING;
    case "OpenPermissions":
      return only({ kind: "showView", view: "permissions" });
    case "ChangeSettings":
      return only({ kind: "updateSettings", patch: command.patch });
    case "RunUpdateAction":
      return only({ kind: "updateAction" });
    case "ReportProblem":
      return only({ kind: "reportProblem" });
    case "CheckPermissions":
      return only({ kind: "checkPermissions" });
    case "OpenPermissionSettings":
      return only({ kind: "openPermissionSettings", key: command.key });
    case "RestartApp":
      return only({ kind: "restartApp" });
    case "ClosePermissions":
      return only({ kind: "showView", view: "connect" });
    case "ChooseWorkspace":
      return screen?.kind === "workspace" &&
        screen.workspaces.some((workspace) => workspace.tenantId === command.tenantId)
        ? only({ kind: "chooseWorkspace", tenantId: command.tenantId })
        : NOTHING;
    case "KeepWorkspace":
      return screen?.kind === "workspace" && screen.failed
        ? only({ kind: "chooseWorkspace", tenantId: "" })
        : NOTHING;
    case "StartConnect":
      return screen?.kind === "welcome"
        ? { events: [{ type: "ConnectStarted", path: "server" }], effects: [] }
        : NOTHING;
    case "CreateWorkspace":
      return screen?.kind === "welcome"
        ? { events: [{ type: "ConnectStarted", path: "create" }], effects: [] }
        : NOTHING;
    case "ToggleInvite":
      return screen?.kind === "welcome"
        ? { events: [{ type: "InviteToggled" }], effects: [] }
        : NOTHING;
    case "EditInvite":
      return { events: [{ type: "InviteEdited", link: command.link }], effects: [] };
    case "OpenInvite":
      return screen?.kind === "welcome" ? openInvite(state, context.requestId) : NOTHING;
    case "JoinInvite": {
      const invitation = state.flow.invitation;
      if (screen?.kind !== "invite" || !screen.invite.valid || !invitation) return NOTHING;
      return {
        events: [{ type: "InviteJoined", origin: invitation.link.origin }],
        effects: [{ kind: "joinInvite", link: state.flow.invite.link }],
      };
    }
    case "ChooseConsent":
      return screen?.kind === "consent"
        ? {
            events: [{ type: "ConsentChosen", topic: screen.topic, give: command.give }],
            effects: [],
          }
        : NOTHING;
    case "ConfirmConsent":
      return confirmConsent(screen);
    default:
      return decideLocal(state, command);
  }
}

function stepTo(step: number, ...effects: Effect[]): Decision {
  return { events: [{ type: "LocalStepChanged", step }], effects };
}

type LocalCommand = Extract<
  Command,
  {
    type:
      | "StartLocalSetup"
      | "LocalPickDataFolder"
      | "LocalNext"
      | "LocalBack"
      | "LocalFinish"
      | "LocalRetry"
      | "LocalOpen"
      | "LocalBackup"
      | "LocalRestore"
      | "LocalMove"
      | "LocalMoveSignIn"
      | "LocalRemoveAll";
  }
>;

export function decideLocal(state: SignInState, command: LocalCommand): Decision {
  const screen = screenOf(state);
  const local = screen?.kind === "local" ? screen : null;
  const busy = state.main?.local.busy !== null;
  switch (command.type) {
    case "StartLocalSetup":
      return state.main?.local.available && !state.main.local.configured
        ? { events: [{ type: "LocalSetupOpened" }], effects: [] }
        : NOTHING;
    case "LocalPickDataFolder":
      return local?.step === 0 && !local.working ? only({ kind: "localPickDataFolder" }) : NOTHING;
    case "LocalNext":
      if (local?.step === 0)
        return local.folderRefusal ? NOTHING : stepTo(1, { kind: "localBegin" });
      return local?.step === 1 ? stepTo(2) : NOTHING;
    case "LocalBack":
      if (!local || local.starting) return NOTHING;
      if (local.step === 0)
        return {
          events: [{ type: "WentBack", to: "connect" }],
          effects: [{ kind: "localCancel" }],
        };
      return stepTo(local.step - 1);
    case "LocalFinish":
      return local?.step === 2
        ? stepTo(LAST_SETUP_STEP, { kind: "localFinish", input: command.input })
        : NOTHING;
    case "LocalRetry":
      return local?.error ? only({ kind: "localBegin" }) : NOTHING;
    case "LocalOpen":
      return local?.done ? only({ kind: "localOpen" }) : NOTHING;
    case "LocalBackup":
      return busy ? NOTHING : only({ kind: "localBackup" });
    case "LocalRestore":
      return busy ? NOTHING : only({ kind: "localRestore", name: command.name });
    case "LocalMove":
      return busy || state.main?.local.moved
        ? NOTHING
        : only({ kind: "localMove", serverOrigin: command.serverOrigin });
    case "LocalRemoveAll":
      return busy || !state.main?.local.configured ? NOTHING : only({ kind: "localRemoveAll" });
    case "LocalMoveSignIn":
      return state.main?.local.moved
        ? only({ kind: "showView", view: "connect" }, { kind: "login", origin: command.origin })
        : NOTHING;
  }
}

function current(flow: FlowUi, requestId: number): boolean {
  return flow.check.phase === "checking" && flow.check.requestId === requestId;
}

export function evolve(state: SignInState, event: Event): SignInState {
  const { flow } = state;
  switch (event.type) {
    case "AddressEdited":
      return {
        ...state,
        flow: {
          ...flow,
          address: event.address,
          check: flow.check.phase === "checking" ? flow.check : { phase: "idle" },
        },
      };
    case "VersionCheckStarted":
      return {
        ...state,
        flow: {
          ...flow,
          address: event.address,
          check: { phase: "checking", requestId: event.requestId },
        },
      };
    case "VersionChecked":
      if (!current(flow, event.requestId)) return state;
      return { ...state, flow: { ...flow, check: { phase: "done", result: event.result } } };
    case "VersionCheckFailed":
      if (!current(flow, event.requestId)) return state;
      return { ...state, flow: { ...flow, check: { phase: "failed" } } };
    case "SignInTargetChosen":
      return {
        ...state,
        flow: {
          ...flow,
          step: "signin",
          target: { origin: event.origin, serverVersion: event.serverVersion },
        },
      };
    case "SignInRefused":
      return {
        ...state,
        flow: {
          ...flow,
          step: "connect",
          address: event.result.origin ?? flow.address,
          reloginDismissed: true,
          check: { phase: "done", result: event.result },
        },
      };
    case "WentBack":
      return {
        ...state,
        flow: {
          ...flow,
          step: event.to,
          ...(event.to === "welcome"
            ? { path: "server" as const, invitation: null, check: { phase: "idle" as const } }
            : {}),
        },
      };
    case "ConnectStarted":
      return {
        ...state,
        flow: { ...flow, step: "connect", path: event.path, invite: CLOSED_INVITE },
      };
    case "InviteToggled":
      return {
        ...state,
        flow: { ...flow, invite: { ...flow.invite, open: !flow.invite.open } },
      };
    case "InviteEdited":
      return {
        ...state,
        flow: {
          ...flow,
          invite: {
            ...flow.invite,
            link: event.link,
            slot: flow.invite.slot.phase === "checking" ? flow.invite.slot : { phase: "idle" },
          },
        },
      };
    case "InviteRejected":
      return {
        ...state,
        flow: { ...flow, invite: { ...flow.invite, slot: { phase: "invalid" } } },
      };
    case "InviteCheckStarted":
      return {
        ...state,
        flow: {
          ...flow,
          invite: { ...flow.invite, slot: { phase: "checking", requestId: event.requestId } },
        },
      };
    case "InviteChecked":
    case "InviteCheckFailed":
      return invited(state, event);
    case "InviteJoined":
      return {
        ...state,
        flow: { ...flow, step: "signin", target: { origin: event.origin, serverVersion: null } },
      };
    case "ConsentChosen":
      return {
        ...state,
        flow: { ...flow, consent: { ...flow.consent, [event.topic]: event.give } },
      };
    case "ReloginDismissed":
      return { ...state, flow: { ...flow, step: "connect", reloginDismissed: true } };
    case "LocalSetupOpened":
      return { ...state, flow: { ...flow, step: "local", localStep: 0 } };
    case "LocalStepChanged":
      return { ...state, flow: { ...flow, localStep: event.step } };
    case "MainStateReceived": {
      const restart = Boolean(state.main?.signedIn) && !event.state.signedIn;
      const base = restart ? INITIAL_FLOW : flow;
      return { main: event.state, flow: forcedStep(event.state, base) };
    }
  }
}

function invited(
  state: SignInState,
  event: Extract<Event, { type: "InviteChecked" | "InviteCheckFailed" }>,
): SignInState {
  const { flow } = state;
  const slot = flow.invite.slot;
  if (slot.phase !== "checking" || slot.requestId !== event.requestId) return state;
  const link = inviteLinkOf(event.link);
  const settled = { ...flow.invite, slot: { phase: "idle" as const } };
  if (!link)
    return { ...state, flow: { ...flow, invite: { ...settled, slot: { phase: "invalid" } } } };
  const check = event.type === "InviteChecked" ? event.check : null;
  if (check?.kind === "link") {
    return { ...state, flow: { ...flow, invite: { ...settled, slot: { phase: "invalid" } } } };
  }
  if (check?.kind === "preview") {
    return {
      ...state,
      flow: {
        ...flow,
        invite: settled,
        step: "invite",
        path: "invite",
        invitation: { link, preview: check.preview },
      },
    };
  }
  return {
    ...state,
    flow: {
      ...flow,
      invite: settled,
      step: "connect",
      path: "server",
      address: link.origin,
      check: check ? { phase: "done", result: check.result } : { phase: "failed" },
    },
  };
}

export function evolveAll(state: SignInState, events: Event[]): SignInState {
  return events.reduce(evolve, state);
}

export interface WindowView {
  screen: Screen;
  frame: FrameModel;
}

export function viewOf(state: SignInState): WindowView | null {
  const screen = screenOf(state);
  return screen && state.main ? { screen, frame: frameFor(screen, state.flow.path) } : null;
}

export function signInAnswered(result: CheckResult | null): Event[] {
  if (!result || result.status === "compatible") return [];
  return [{ type: "SignInRefused", result }];
}
