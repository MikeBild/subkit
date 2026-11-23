import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import {
  type CheckResult,
  type CheckStatus,
  type ConnectState,
  LOCAL_UNAVAILABLE,
  type ProfileSummary,
} from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { CLOSED_REPORT } from "../../shared/problem-report.ts";
import { INITIAL_FLOW } from "./screens-model.ts";
import {
  type Command,
  decide,
  type Effect,
  type Event,
  evolve,
  evolveAll,
  INITIAL_STATE,
  type SignInState,
  signInAnswered,
  viewOf,
} from "./sign-in-model.ts";

const ORIGIN = "https://subkit.example.com";
const CONTEXT = { requestId: 7 };

const profile: ProfileSummary = {
  id: "p1",
  label: "work.example.com",
  serverOrigin: "https://work.example.com",
  signedIn: false,
  active: true,
};

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
    profiles: [profile],
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
    defaultServer: null,
    report: CLOSED_REPORT,
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

function checked(status: CheckStatus, extra: Partial<CheckResult> = {}): SignInState {
  const started = run(ready(), { type: "CheckServer", address: "subkit.example.com" }).state;
  return evolve(started, { type: "VersionChecked", requestId: 7, result: result(status, extra) });
}

describe("sign-in model: before the main process answers", () => {
  test("there is nothing to draw yet", () => {
    expect(viewOf(INITIAL_STATE)).toBeNull();
  });

  test("the first state from the main process shows the connect step", () => {
    const view = viewOf(ready());
    expect(view?.screen.kind).toBe("connect");
    expect(view?.frame.dots.current).toBe(0);
  });
});

describe("sign-in model: version check", () => {
  test("typing keeps the address and clears an old result", () => {
    const state = run(checked("unreachable"), { type: "EditAddress", address: "sub" }).state;
    expect(state.flow.address).toBe("sub");
    expect(state.flow.check).toEqual({ phase: "idle" });
  });

  test("checking starts with the id from the shell and asks the bridge once", () => {
    const { events, effects, state } = run(ready(), {
      type: "CheckServer",
      address: "subkit.example.com",
    });
    expect(events).toEqual([
      { type: "VersionCheckStarted", address: "subkit.example.com", requestId: 7 },
    ]);
    expect(effects).toEqual([{ kind: "checkServer", address: "subkit.example.com", requestId: 7 }]);
    expect(state.flow.check).toEqual({ phase: "checking", requestId: 7 });
  });

  test("a second check while one runs does nothing", () => {
    const running = run(ready(), { type: "CheckServer", address: "a" }).state;
    expect(decide(running, { type: "CheckServer", address: "b" }, CONTEXT)).toEqual({
      events: [],
      effects: [],
    });
  });

  test("typing during a check keeps the check running", () => {
    const running = run(ready(), { type: "CheckServer", address: "a" }).state;
    const state = run(running, { type: "EditAddress", address: "ab" }).state;
    expect(state.flow.check.phase).toBe("checking");
  });

  test("the answer of the running check lands, a stale one is dropped", () => {
    const running = run(ready(), { type: "CheckServer", address: "a" }, 3).state;
    const stale = evolve(running, {
      type: "VersionChecked",
      requestId: 2,
      result: result("compatible"),
    });
    expect(stale).toBe(running);
    const done = evolve(running, {
      type: "VersionChecked",
      requestId: 3,
      result: result("compatible"),
    });
    expect(done.flow.check.phase).toBe("done");
  });

  test("a check that throws is shown as unreachable", () => {
    const running = run(ready(), { type: "CheckServer", address: "a" }).state;
    const failed = evolve(running, { type: "VersionCheckFailed", requestId: 7 });
    expect(failed.flow.check).toEqual({ phase: "failed" });
    expect(evolve(failed, { type: "VersionCheckFailed", requestId: 7 })).toBe(failed);
    const view = viewOf(failed);
    expect(view?.screen.kind === "connect" && view.screen.slot.kind === "outcome").toBe(true);
  });

  test("retry from a result checks the typed address again", () => {
    const { effects } = run(checked("unreachable"), {
      type: "ActOnNotice",
      action: { kind: "recheck" },
    });
    expect(effects).toEqual([{ kind: "checkServer", address: "subkit.example.com", requestId: 7 }]);
  });
});

describe("sign-in model: from the server to the browser", () => {
  test("Next after a fitting server moves to sign-in for that server", () => {
    const { state } = run(checked("compatible"), { type: "ContinueToSignIn" });
    expect(state.flow.step).toBe("signin");
    expect(state.flow.target).toEqual({ origin: ORIGIN, serverVersion: "11.2.0" });
    expect(viewOf(state)?.screen.kind).toBe("signin");
  });

  test("Next does nothing while the server does not fit", () => {
    expect(decide(checked("server-too-old"), { type: "ContinueToSignIn" }, CONTEXT).events).toEqual(
      [],
    );
    expect(decide(ready(), { type: "ContinueToSignIn" }, CONTEXT).events).toEqual([]);
  });

  test("opening the browser and canceling are bridge calls only", () => {
    expect(decide(ready(), { type: "StartSignIn", origin: ORIGIN }, CONTEXT)).toEqual({
      events: [],
      effects: [{ kind: "login", origin: ORIGIN }],
    });
    expect(decide(ready(), { type: "CancelSignIn" }, CONTEXT).effects).toEqual([
      { kind: "cancelLogin" },
    ]);
  });

  test("a sign-in the main process refuses returns to the server step with its result", () => {
    const signin = run(checked("compatible"), { type: "ContinueToSignIn" }).state;
    const refused = result("app-too-old", { minAppVersion: "12.0.0" });
    expect(signInAnswered(refused)).toEqual([{ type: "SignInRefused", result: refused }]);
    expect(signInAnswered(result("compatible"))).toEqual([]);
    expect(signInAnswered(null)).toEqual([]);
    const state = evolveAll(signin, signInAnswered(refused));
    expect(state.flow.step).toBe("connect");
    expect(state.flow.address).toBe(ORIGIN);
    expect(state.flow.reloginDismissed).toBe(true);
  });

  test("back from a waiting sign-in cancels it, back from a ready one only steps back", () => {
    const signin = run(checked("compatible"), { type: "ContinueToSignIn" }).state;
    const waiting = evolve(signin, {
      type: "MainStateReceived",
      state: main({ login: { phase: "waiting", origin: ORIGIN } }),
    });
    const fromWaiting = run(waiting, { type: "GoBack" });
    expect(fromWaiting.effects).toEqual([{ kind: "cancelLogin" }]);
    expect(fromWaiting.state.flow.step).toBe("connect");
    const fromReady = run(signin, { type: "GoBack" });
    expect(fromReady.effects).toEqual([]);
    expect(fromReady.events).toEqual([{ type: "WentBack", to: "connect" }]);
  });

  test("a sign-in started elsewhere pulls the window to that server's sign-in step", () => {
    const state = evolve(ready(), {
      type: "MainStateReceived",
      state: main({ login: { phase: "waiting", origin: ORIGIN } }),
    });
    expect(state.flow.step).toBe("signin");
    expect(viewOf(state)?.screen.kind).toBe("signin");
  });

  test("signed in, Open SubKit opens that server and nothing else", () => {
    const state = ready({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" } });
    expect(decide(state, { type: "OpenSubKit" }, CONTEXT)).toEqual({
      events: [],
      effects: [{ kind: "openProfile", profileId: "p1" }],
    });
    expect(decide(ready(), { type: "OpenSubKit" }, CONTEXT).effects).toEqual([]);
  });

  test("leaving a finished sign-in starts the flow over with an empty field", () => {
    let state = run(checked("compatible"), { type: "ContinueToSignIn" }).state;
    state = evolve(state, {
      type: "MainStateReceived",
      state: main({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: null } }),
    });
    state = evolve(state, { type: "MainStateReceived", state: main() });
    expect(state.flow).toEqual({ ...INITIAL_FLOW, step: "connect" });
  });
});

describe("sign-in model: expired, revoked and offline", () => {
  const expired = () => ready({ notice: { kind: "expired", profileId: "p1" } });

  test("an expired session shows the relogin screen for that server", () => {
    const view = viewOf(expired());
    expect(view?.screen.kind === "relogin" && view.screen.host).toBe("work.example.com");
  });

  test("connecting another server leaves relogin for the connect step", () => {
    const { state, events } = run(expired(), { type: "ConnectAnotherServer" });
    expect(events).toEqual([{ type: "ReloginDismissed" }]);
    expect(viewOf(state)?.screen.kind).toBe("connect");
  });

  test("the revoked notice signs in again, the offline notice opens the server", () => {
    expect(
      decide(ready(), { type: "ActOnNotice", action: { kind: "sign-in", origin: ORIGIN } }, CONTEXT)
        .effects,
    ).toEqual([{ kind: "login", origin: ORIGIN }]);
    expect(
      decide(
        ready(),
        { type: "ActOnNotice", action: { kind: "open-profile", profileId: "p1" } },
        CONTEXT,
      ).effects,
    ).toEqual([{ kind: "openProfile", profileId: "p1" }]);
  });
});

describe("sign-in model: settings", () => {
  test("the toggle opens settings and closes them again", () => {
    expect(decide(ready(), { type: "ToggleSettings" }, CONTEXT).effects).toEqual([
      { kind: "showView", view: "settings" },
    ]);
    expect(
      decide(ready({ view: "settings" }), { type: "ToggleSettings" }, CONTEXT).effects,
    ).toEqual([{ kind: "showView", view: "connect" }]);
  });

  test("back from the permission setup returns to the flow", () => {
    const { events, effects } = run(ready({ view: "permissions" }), { type: "GoBack" });
    expect(events).toEqual([]);
    expect(effects).toEqual([{ kind: "showView", view: "connect" }]);
  });

  test("local capabilities open from settings as their own view and back returns to settings", () => {
    const opened = run(ready({ view: "settings" }), { type: "OpenLocalCapabilities" });
    expect(opened.effects).toEqual([{ kind: "showView", view: "local" }]);
    const shown = ready({ view: "local" });
    expect(viewOf(shown)?.screen).toEqual({
      kind: "local-capabilities",
      device: "MacBook-Anna",
      signedIn: false,
      supported: true,
    });
    expect(viewOf(shown)?.frame.settingsOpen).toBe(true);
    expect(run(shown, { type: "GoBack" }).effects).toEqual([
      { kind: "showView", view: "settings" },
    ]);
  });

  test("the permissions view opens from anywhere", () => {
    expect(run(ready({ view: "local" }), { type: "OpenPermissions" }).effects).toEqual([
      { kind: "showView", view: "permissions" },
    ]);
  });

  test("local capabilities open only from settings", () => {
    expect(decide(ready(), { type: "OpenLocalCapabilities" }, CONTEXT)).toEqual({
      events: [],
      effects: [],
    });
  });

  test("closing settings also closes local capabilities, so settings reopen at the top", () => {
    expect(run(ready({ view: "local" }), { type: "ToggleSettings" }).effects).toEqual([
      { kind: "showView", view: "connect" },
    ]);
    expect(run(ready({ view: "settings" }), { type: "ToggleSettings" }).effects).toEqual([
      { kind: "showView", view: "connect" },
    ]);
    expect(run(ready(), { type: "ToggleSettings" }).effects).toEqual([
      { kind: "showView", view: "settings" },
    ]);
  });

  test("back from settings returns to the flow without changing the step", () => {
    const { events, effects } = run(ready({ view: "settings" }), { type: "GoBack" });
    expect(events).toEqual([]);
    expect(effects).toEqual([{ kind: "showView", view: "connect" }]);
  });

  test("signing in to a known server goes straight to its sign-in step", () => {
    const { state, effects } = run(ready({ view: "settings" }), {
      type: "SignInToServer",
      profileId: "p1",
    });
    expect(effects).toEqual([{ kind: "showView", view: "connect" }]);
    expect(state.flow.target).toEqual({ origin: profile.serverOrigin, serverVersion: null });
    expect(decide(ready(), { type: "SignInToServer", profileId: "nope" }, CONTEXT)).toEqual({
      events: [],
      effects: [],
    });
  });

  test("server, settings, update and report commands become bridge calls", () => {
    const cases: [Command, Effect][] = [
      [
        { type: "OpenServer", profileId: "p1" },
        { kind: "openProfile", profileId: "p1" },
      ],
      [
        { type: "RemoveServer", profileId: "p1" },
        { kind: "removeProfile", profileId: "p1" },
      ],
      [
        { type: "ChangeSettings", patch: { launchAtLogin: true } },
        { kind: "updateSettings", patch: { launchAtLogin: true } },
      ],
      [{ type: "RunUpdateAction" }, { kind: "updateAction" }],
      [{ type: "ReportProblem" }, { kind: "reportProblem" }],
      [{ type: "CheckPermissions" }, { kind: "checkPermissions" }],
      [
        { type: "OpenPermissionSettings", key: "screen" },
        { kind: "openPermissionSettings", key: "screen" },
      ],
      [{ type: "RestartApp" }, { kind: "restartApp" }],
      [{ type: "ClosePermissions" }, { kind: "showView", view: "connect" }],
    ];
    for (const [command, effect] of cases) {
      expect(decide(ready(), command, CONTEXT)).toEqual({ events: [], effects: [effect] });
    }
  });
});

describe("sign-in model: determinism", () => {
  test("the same commands with the same ids give the same state", () => {
    const commands: Command[] = [
      { type: "EditAddress", address: "subkit.example.com" },
      { type: "CheckServer", address: "subkit.example.com" },
    ];
    const once = () => {
      let state = ready();
      const events: Event[] = [];
      for (const [index, command] of commands.entries()) {
        const decision = decide(state, command, { requestId: index + 1 });
        events.push(...decision.events);
        state = evolveAll(state, decision.events);
      }
      return { state, events };
    };
    expect(once()).toEqual(once());
  });
});

describe("sign-in model: default server", () => {
  const CLOUD = "https://subkit-cloud.example";

  test("the first state prefills the default server once", () => {
    const state = ready({ defaultServer: CLOUD });
    expect(state.flow.address).toBe(CLOUD);
    const cleared = run(state, { type: "EditAddress", address: "" }).state;
    const later = evolve(cleared, {
      type: "MainStateReceived",
      state: main({ defaultServer: CLOUD }),
    });
    expect(later.flow.address).toBe("");
  });

  test("without a default server the address stays empty", () => {
    expect(ready().flow.address).toBe("");
  });
});

describe("sign-in model: problem report", () => {
  const open = { ...CLOSED_REPORT, host: "subkit-cloud.example" };

  test("the report screen sends the description and the choice once", () => {
    const state = ready({ view: "report", report: open });
    expect(viewOf(state)?.screen).toEqual({ kind: "report", report: open });
    expect(viewOf(state)?.frame.settingsOpen).toBe(false);
    expect(viewOf(state)?.frame.dots.visible).toBe(false);
    const input = { message: "blank window", attach: true };
    expect(decide(state, { type: "SubmitReport", input }, CONTEXT)).toEqual({
      events: [],
      effects: [{ kind: "submitReport", input }],
    });
  });

  test("Send does nothing without a server or outside the report screen", () => {
    const input = { message: "", attach: false };
    const nowhere = ready({ view: "report", report: CLOSED_REPORT });
    expect(decide(nowhere, { type: "SubmitReport", input }, CONTEXT).effects).toEqual([]);
    expect(decide(ready(), { type: "SubmitReport", input }, CONTEXT).effects).toEqual([]);
  });

  test("closing the report returns to the connect window, save asks the shell", () => {
    const state = ready({ view: "report", report: open });
    expect(decide(state, { type: "CloseReport" }, CONTEXT).effects).toEqual([
      { kind: "showView", view: "connect" },
    ]);
    expect(decide(ready(), { type: "CloseReport" }, CONTEXT).effects).toEqual([]);
    expect(decide(state, { type: "SaveDiagnostics" }, CONTEXT).effects).toEqual([
      { kind: "saveDiagnostics" },
    ]);
  });
});
