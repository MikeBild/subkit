import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import {
  type CheckResult,
  type CheckStatus,
  type ConnectState,
  LOCAL_UNAVAILABLE,
} from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import {
  type Command,
  decide,
  evolve,
  evolveAll,
  INITIAL_STATE,
  type SignInState,
  signInAnswered,
  viewOf,
} from "./sign-in-model.ts";

const ORIGIN = "https://subkit.example.com";
const CONTEXT = { requestId: 7 };
const LINK = "https://subkit.example.com/cockpit/invite#wf_invite_abcdefgh12345678";

function result(status: CheckStatus, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    status,
    origin: ORIGIN,
    serverVersion: "11.2.0",
    minAppVersion: null,
    minServerVersion: "11.2.0",
    ...extra,
  };
}

function main(patch: Partial<ConnectState> = {}): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook-Anna",
    locale: "de",
    messages: dictionary("de"),
    view: "connect",
    profiles: [],
    settings: {
      locale: "system",
      launchAtLogin: false,
      quietHours: { enabled: false, start: "22:00", end: "07:00" },
      notifications: true,
      shareDiagnostics: false,
    },
    login: { phase: "idle" },
    notice: null,
    signedIn: null,
    onboarding: NO_ONBOARDING,
    update: { phase: "disabled" },
    permissions: {
      supported: true,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    ...patch,
  };
}

function ready(patch: Partial<ConnectState> = {}): SignInState {
  return evolve(INITIAL_STATE, { type: "MainStateReceived", state: main(patch) });
}

function run(state: SignInState, command: Command, requestId = 7) {
  const decision = decide(state, command, { requestId });
  return { ...decision, state: evolveAll(state, decision.events) };
}

function typed(): SignInState {
  const open = run(ready(), { type: "ToggleInvite" }).state;
  return run(open, { type: "EditInvite", link: LINK }).state;
}

const VALID = {
  status: "valid" as const,
  origin: ORIGIN,
  workspace: "Harmoniqs",
  invitedBy: "Anna Schmidt",
  emailHint: "m•••@example.com",
  expiresAt: "2026-11-27T12:00:00.000Z",
};

function shown(): SignInState {
  const { state } = run(typed(), { type: "OpenInvite" });
  return evolve(state, {
    type: "InviteChecked",
    requestId: 7,
    link: LINK,
    check: { kind: "preview", preview: VALID },
  });
}

describe("first run: welcome", () => {
  test("a first start shows welcome without dots, Get started goes to the connect step", () => {
    expect(viewOf(ready())?.screen.kind).toBe("welcome");
    expect(viewOf(ready())?.frame.dots.visible).toBe(false);
    const { state } = run(ready(), { type: "StartConnect" });
    expect(viewOf(state)?.screen.kind).toBe("connect");
    expect(viewOf(state)?.frame.dots).toEqual({ visible: true, current: 0, total: 6 });
    expect(run(state, { type: "GoBack" }).state.flow.step).toBe("welcome");
  });

  test("the invitation field opens and closes from the welcome step only", () => {
    const open = run(ready(), { type: "ToggleInvite" }).state;
    const screen = viewOf(open)?.screen;
    expect(screen?.kind === "welcome" && screen.invite.open).toBe(true);
    expect(run(open, { type: "ToggleInvite" }).state.flow.invite.open).toBe(false);
    const connect = run(ready(), { type: "StartConnect" }).state;
    expect(decide(connect, { type: "ToggleInvite" }, CONTEXT).events).toEqual([]);
  });
});

describe("first run: create a workspace", () => {
  test("Create goes to the connect step on its own path, back returns to welcome", () => {
    const { state } = run(ready(), { type: "CreateWorkspace" });
    expect(state.flow.path).toBe("create");
    expect(viewOf(state)?.screen.kind).toBe("connect");
    expect(viewOf(state)?.frame.dots).toEqual({ visible: true, current: 0, total: 6 });
    const back = run(state, { type: "GoBack" }).state;
    expect(back.flow.step).toBe("welcome");
    expect(back.flow.path).toBe("server");
  });

  test("Create is refused outside the welcome step", () => {
    const connect = run(ready(), { type: "StartConnect" }).state;
    expect(decide(connect, { type: "CreateWorkspace" }, CONTEXT).events).toEqual([]);
  });

  test("after a fitting server, sign-in says the workspace gets its name in the browser", () => {
    const created = run(ready(), { type: "CreateWorkspace" }).state;
    const checked = evolveAll(created, [
      { type: "VersionCheckStarted", address: ORIGIN, requestId: 7 },
      { type: "VersionChecked", requestId: 7, result: result("compatible") },
    ]);
    const signin = run(checked, { type: "ContinueToSignIn" }).state;
    const view = viewOf(signin);
    expect(view?.frame.dots).toEqual({ visible: true, current: 1, total: 6 });
    expect(view?.screen.kind === "signin" && view.screen.hint).toBe("signin.create");
    expect(run(signin, { type: "StartSignIn", origin: ORIGIN }).effects).toEqual([
      { kind: "login", origin: ORIGIN },
    ]);
  });

  test("Get started stays on the server path without a hint", () => {
    const started = run(ready(), { type: "StartConnect" }).state;
    const checked = evolveAll(started, [
      { type: "VersionCheckStarted", address: ORIGIN, requestId: 7 },
      { type: "VersionChecked", requestId: 7, result: result("compatible") },
    ]);
    const view = viewOf(run(checked, { type: "ContinueToSignIn" }).state);
    expect(view?.screen.kind === "signin" && view.screen.hint).toBeNull();
  });
});

describe("first run: invitation link", () => {
  test("a link that is not an invitation is refused here, without asking the server", () => {
    const open = run(ready(), { type: "ToggleInvite" }).state;
    const wrong = run(open, { type: "EditInvite", link: "https://subkit.example.com/cockpit" });
    const { effects, state: refused } = run(wrong.state, { type: "OpenInvite" });
    expect(effects).toEqual([]);
    const screen = viewOf(refused)?.screen;
    expect(screen?.kind === "welcome" && screen.invite.error).toBe("welcome.invite.invalid");
    const again = viewOf(run(refused, { type: "EditInvite", link: LINK }).state)?.screen;
    expect(again?.kind === "welcome" && again.invite.error).toBeNull();
  });

  test("opening a link asks the main process once and shows the invitation", () => {
    const { effects, state } = run(typed(), { type: "OpenInvite" });
    expect(effects).toEqual([{ kind: "checkInvite", link: LINK, requestId: 7 }]);
    const busy = viewOf(state)?.screen;
    expect(busy?.kind === "welcome" && busy.invite.checking).toBe(true);
    expect(decide(state, { type: "OpenInvite" }, CONTEXT)).toEqual({ events: [], effects: [] });
    const view = viewOf(shown());
    expect(view?.screen.kind).toBe("invite");
    expect(view?.frame.dots).toEqual({ visible: true, current: 0, total: 6 });
    expect(shown().flow.path).toBe("invite");
  });

  test("a stale answer is dropped", () => {
    const { state } = run(typed(), { type: "OpenInvite" });
    const stale = evolve(state, {
      type: "InviteChecked",
      requestId: 3,
      link: LINK,
      check: { kind: "preview", preview: VALID },
    });
    expect(stale).toBe(state);
  });

  test("a link the main process cannot read shows the field error", () => {
    const { state } = run(typed(), { type: "OpenInvite" });
    const refused = evolve(state, {
      type: "InviteChecked",
      requestId: 7,
      link: LINK,
      check: { kind: "link" },
    });
    const screen = viewOf(refused)?.screen;
    expect(screen?.kind === "welcome" && screen.invite.error).toBe("welcome.invite.invalid");
  });

  test("joining starts join and device sign-in as one browser flow, back returns to the invitation", () => {
    const joined = run(shown(), { type: "JoinInvite" });
    expect(joined.effects).toEqual([{ kind: "joinInvite", link: LINK }]);
    const waiting = evolve(joined.state, {
      type: "MainStateReceived",
      state: main({ login: { phase: "waiting", origin: ORIGIN } }),
    });
    const view = viewOf(waiting);
    expect(view?.screen.kind).toBe("signin");
    expect(view?.frame.dots).toEqual({ visible: true, current: 1, total: 6 });
    const screen = view?.screen;
    expect(screen?.kind === "signin" && screen.signin.phase).toBe("waiting");
    expect(screen?.kind === "signin" && screen.hint).toBe("signin.join");
    const back = run(waiting, { type: "GoBack" });
    expect(back.effects).toEqual([{ kind: "cancelLogin" }]);
    expect(back.state.flow.step).toBe("invite");
  });

  test("a server that refuses the device sign-in behind the invitation lands on connect", () => {
    const joined = run(shown(), { type: "JoinInvite" }).state;
    const old = result("app-too-old", { minAppVersion: "99.0.0" });
    const refused = evolveAll(joined, signInAnswered(old));
    expect(refused.flow.step).toBe("connect");
    expect(refused.flow.check).toEqual({ phase: "done", result: old });
    expect(evolveAll(joined, signInAnswered(null))).toBe(joined);
  });

  test("an expired invitation cannot be joined, back returns to welcome", () => {
    const { state } = run(typed(), { type: "OpenInvite" });
    const expired = evolve(state, {
      type: "InviteChecked",
      requestId: 7,
      link: LINK,
      check: { kind: "preview", preview: { status: "expired", origin: ORIGIN } },
    });
    expect(decide(expired, { type: "JoinInvite" }, CONTEXT).effects).toEqual([]);
    const back = run(expired, { type: "GoBack" }).state;
    expect(viewOf(back)?.screen.kind).toBe("welcome");
    expect(back.flow.path).toBe("server");
    expect(back.flow.invitation).toBeNull();
  });

  test("a server problem behind the link lands on the connect step with that result", () => {
    const { state } = run(typed(), { type: "OpenInvite" });
    const old = result("server-too-old", { serverVersion: "9.2.0" });
    const landed = evolve(state, {
      type: "InviteChecked",
      requestId: 7,
      link: LINK,
      check: { kind: "server", result: old },
    });
    expect(landed.flow.step).toBe("connect");
    expect(landed.flow.address).toBe(ORIGIN);
    expect(landed.flow.check).toEqual({ phase: "done", result: old });
    const failed = evolve(state, { type: "InviteCheckFailed", requestId: 7, link: LINK });
    expect(failed.flow.check).toEqual({ phase: "failed" });
  });
});

describe("first run: one consent pattern", () => {
  const signedIn = { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" };
  const steps = ["notifications", "diagnostics"] as ("notifications" | "diagnostics")[];

  test("Next waits for a choice, then sends exactly that answer", () => {
    const asking = ready({ signedIn, onboarding: { ...NO_ONBOARDING, steps } });
    expect(decide(asking, { type: "ConfirmConsent" }, CONTEXT).effects).toEqual([]);
    const allowed = run(asking, { type: "ChooseConsent", give: true }).state;
    expect(viewOf(allowed)?.screen).toEqual({
      kind: "consent",
      topic: "notifications",
      choice: true,
    });
    expect(decide(allowed, { type: "ConfirmConsent" }, CONTEXT).effects).toEqual([
      { kind: "answerNotifications", allow: true },
    ]);
  });

  test("diagnostics use the same pattern and send their own answer", () => {
    const asking = ready({
      signedIn,
      onboarding: { ...NO_ONBOARDING, steps, done: ["notifications"] },
    });
    const declined = run(asking, { type: "ChooseConsent", give: false }).state;
    expect(decide(declined, { type: "ConfirmConsent" }, CONTEXT).effects).toEqual([
      { kind: "answerDiagnostics", share: false },
    ]);
  });
});
