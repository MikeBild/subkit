import type { InviteCheck } from "../../shared/invite-link.ts";
import type { CheckResult, ConnectState, ConnectView, SettingsPatch } from "../../shared/ipc.ts";
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
  | { type: "ChangeSettings"; patch: SettingsPatch }
  | { type: "RunUpdateAction" }
  | { type: "ReportProblem" }
  | { type: "ChooseWorkspace"; tenantId: string }
  | { type: "KeepWorkspace" }
  | { type: "StartConnect" }
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
  | { type: "ConnectStarted" }
  | { type: "InviteToggled" }
  | { type: "InviteEdited"; link: string }
  | { type: "InviteRejected" }
  | { type: "InviteCheckStarted"; requestId: number }
  | { type: "InviteChecked"; requestId: number; link: string; check: InviteCheck }
  | { type: "InviteCheckFailed"; requestId: number; link: string }
  | { type: "InviteJoined"; origin: string }
  | { type: "ConsentChosen"; topic: ConsentTopic; give: boolean }
  | { type: "MainStateReceived"; state: ConnectState };

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
      if (screen?.kind === "settings") return only({ kind: "showView", view: "connect" });
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
        view: state.main?.view === "settings" ? "connect" : "settings",
      });
    case "ChangeSettings":
      return only({ kind: "updateSettings", patch: command.patch });
    case "RunUpdateAction":
      return only({ kind: "updateAction" });
    case "ReportProblem":
      return only({ kind: "reportProblem" });
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
        ? { events: [{ type: "ConnectStarted" }], effects: [] }
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
        flow: { ...flow, step: "connect", path: "server", invite: CLOSED_INVITE },
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
