import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import {
  type ConnectState,
  type ConnectView,
  LOCAL_UNAVAILABLE,
  type ProfileSummary,
} from "../../shared/ipc.ts";
import { completeStep, NO_ONBOARDING, startOnboarding } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { CLOSED_REPORT } from "../../shared/problem-report.ts";
import {
  type Command,
  decide,
  type Effect,
  evolve,
  evolveAll,
  INITIAL_STATE,
  type SignInState,
  viewOf,
} from "./sign-in-model.ts";

const SIGNED_IN: ProfileSummary = {
  id: "p1",
  label: "subkit-cloud.mikebild.dev",
  serverOrigin: "https://subkit-cloud.mikebild.dev",
  signedIn: true,
  active: true,
};

function main(patch: Partial<ConnectState> = {}): ConnectState {
  return {
    appVersion: "12.1.5",
    deviceLabel: "M314-2.local",
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
      permissions: { accessibility: true, screen: true, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    defaultServer: "https://subkit-cloud.mikebild.dev",
    report: CLOSED_REPORT,
    ...patch,
  };
}

const FRESH: Partial<ConnectState> = {};
const COMPLETED: Partial<ConnectState> = { profiles: [SIGNED_IN] };

function opened(base: Partial<ConnectState>, view: ConnectView): SignInState {
  return evolve(INITIAL_STATE, { type: "MainStateReceived", state: main({ ...base, view }) });
}

function act(state: SignInState, command: Command) {
  const decision = decide(state, command, { requestId: 1 });
  return { ...decision, state: evolveAll(state, decision.events) };
}

function shown(state: SignInState, base: Partial<ConnectState>, view: ConnectView): SignInState {
  return evolve(state, { type: "MainStateReceived", state: main({ ...base, view }) });
}

const TO_COCKPIT: Effect[] = [
  { kind: "showView", view: "connect" },
  { kind: "openProfile", profileId: "p1" },
];
const TO_WIZARD: Effect[] = [{ kind: "showView", view: "connect" }];

describe("entry: first run on a fresh install", () => {
  test("the wizard shows step dots and no back on the first step", () => {
    const state = opened(FRESH, "connect");
    const view = viewOf(state);
    expect(view?.screen.kind).toBe("welcome");
    expect(view?.nav).toBeNull();
    const started = act(state, { type: "StartConnect" }).state;
    const connect = viewOf(started);
    expect(connect?.screen.kind).toBe("connect");
    expect(connect?.frame.dots).toMatchObject({ visible: true, current: 0 });
    expect(connect?.screen).toMatchObject({ back: true });
  });

  test("onboarding steps after the first sign-in stay in the wizard", () => {
    const onboarding = completeStep(
      startOnboarding([], { notificationsAsked: false, diagnosticsAsked: true }),
      "workspace",
    );
    const state = opened(
      {
        ...COMPLETED,
        signedIn: { profileId: "p1", origin: SIGNED_IN.serverOrigin, serverVersion: "12.1.5" },
        onboarding,
      },
      "connect",
    );
    expect(viewOf(state)?.screen.kind).toBe("consent");
    expect(viewOf(state)?.frame.dots.visible).toBe(true);
  });
});

describe("entry: a completed install never shows the wizard", () => {
  for (const view of ["connect", "settings", "local", "permissions", "report"] as const) {
    test(`${view} has no step dots`, () => {
      expect(viewOf(opened(COMPLETED, view))?.frame.dots.visible).toBe(false);
    });
  }

  test("an upgrade from 12.1.3 or 12.1.4 with a signed-in server counts as complete", () => {
    const upgraded = opened(
      { profiles: [SIGNED_IN], signedIn: null, onboarding: NO_ONBOARDING },
      "connect",
    );
    expect(viewOf(upgraded)?.frame.dots.visible).toBe(false);
    expect(act(opened(COMPLETED, "settings"), { type: "GoBack" }).effects).toEqual(TO_COCKPIT);
  });
});

describe("entry: settings", () => {
  test("from the tray on a completed install: one close back to the Cockpit", () => {
    const state = opened(COMPLETED, "settings");
    expect(viewOf(state)?.nav).toEqual({ back: "common.close", later: false });
    expect(act(state, { type: "GoBack" }).effects).toEqual(TO_COCKPIT);
    expect(act(state, { type: "ToggleSettings" }).effects).toEqual(TO_COCKPIT);
  });

  test("from the tray during the first setup: back returns to the wizard step", () => {
    const state = opened(FRESH, "settings");
    expect(viewOf(state)?.nav).toEqual({ back: "common.back", later: false });
    expect(act(state, { type: "GoBack" }).effects).toEqual(TO_WIZARD);
  });

  test("from the gear in the window: back returns to the view it came from", () => {
    const start = opened(COMPLETED, "connect");
    const toggled = act(start, { type: "ToggleSettings" });
    expect(toggled.effects).toEqual([{ kind: "showView", view: "settings" }]);
    const state = shown(toggled.state, COMPLETED, "settings");
    expect(viewOf(state)?.nav).toEqual({ back: "common.back", later: false });
    expect(act(state, { type: "GoBack" }).effects).toEqual([{ kind: "showView", view: "connect" }]);
  });
});

describe("entry: local capabilities", () => {
  test("from settings: back returns to settings, then settings close to the Cockpit", () => {
    const settings = opened(COMPLETED, "settings");
    const moved = act(settings, { type: "OpenLocalCapabilities" });
    const local = shown(moved.state, COMPLETED, "local");
    expect(viewOf(local)?.nav).toEqual({ back: "common.back", later: false });
    const back = act(local, { type: "GoBack" });
    expect(back.effects).toEqual([{ kind: "showView", view: "settings" }]);
    const again = shown(back.state, COMPLETED, "settings");
    expect(viewOf(again)?.nav).toEqual({ back: "common.close", later: false });
    expect(act(again, { type: "GoBack" }).effects).toEqual(TO_COCKPIT);
  });

  test("from the tray: one close back to the Cockpit, never into a wizard step", () => {
    const state = opened(COMPLETED, "local");
    expect(viewOf(state)?.nav).toEqual({ back: "common.close", later: false });
    expect(act(state, { type: "GoBack" }).effects).toEqual(TO_COCKPIT);
  });
});

describe("entry: permission setup", () => {
  const PARTIAL: Partial<ConnectState> = {
    ...COMPLETED,
    permissions: {
      supported: true,
      permissions: { accessibility: true, screen: false, restartPending: false },
      lost: [],
    },
  };

  test("from local capabilities: back and done both return there", () => {
    const local = opened(PARTIAL, "local");
    const moved = act(local, { type: "OpenPermissions" });
    const state = shown(moved.state, PARTIAL, "permissions");
    expect(viewOf(state)?.nav).toEqual({ back: "common.back", later: false });
    expect(act(state, { type: "FinishPermissions" }).effects).toEqual([
      { kind: "showView", view: "local" },
    ]);
    expect(act(state, { type: "GoBack" }).effects).toEqual([{ kind: "showView", view: "local" }]);
  });

  test("from a notification or the first use: later and done close to the main state", () => {
    const state = opened(PARTIAL, "permissions");
    expect(viewOf(state)?.nav).toEqual({ back: null, later: true });
    expect(act(state, { type: "ClosePermissions" }).effects).toEqual(TO_COCKPIT);
    expect(act(state, { type: "FinishPermissions" }).effects).toEqual(TO_COCKPIT);
  });

  test("later during the first setup returns to the wizard, not to another step", () => {
    expect(act(opened(FRESH, "permissions"), { type: "ClosePermissions" }).effects).toEqual(
      TO_WIZARD,
    );
  });

  test("a partial setup shows only what is still missing", () => {
    const view = viewOf(opened(PARTIAL, "permissions"));
    expect(view?.screen).toMatchObject({
      kind: "permissions",
      setup: { cards: [{ key: "screen", granted: false }], done: false },
    });
  });
});

describe("entry: problem report", () => {
  test("from the window: closing returns to the view it came from", () => {
    const settings = opened(COMPLETED, "settings");
    const asked = act(settings, { type: "ReportProblem" });
    const report = shown(asked.state, COMPLETED, "report");
    expect(act(report, { type: "CloseReport" }).effects).toEqual([
      { kind: "showView", view: "settings" },
    ]);
  });

  test("from the tray or menu: closing returns to the Cockpit", () => {
    expect(act(opened(COMPLETED, "report"), { type: "CloseReport" }).effects).toEqual(TO_COCKPIT);
  });
});

describe("entry: sign-in from settings", () => {
  test("back from the sign-in step returns to settings", () => {
    const signedOut = { ...SIGNED_IN, id: "p2", serverOrigin: "https://work.example.com" };
    const base = { profiles: [SIGNED_IN, { ...signedOut, signedIn: false, active: false }] };
    const settings = opened(base, "settings");
    const chosen = act(settings, { type: "SignInToServer", profileId: "p2" });
    const signin = shown(chosen.state, base, "connect");
    expect(viewOf(signin)?.screen.kind).toBe("signin");
    expect(viewOf(signin)?.frame.dots.visible).toBe(false);
    const back = act(signin, { type: "GoBack" });
    expect(back.effects).toEqual([{ kind: "showView", view: "settings" }]);
    expect(back.state.flow.step).toBe("connect");
  });
});

describe("entries from the main process reset the way back", () => {
  test("a notification that opens another view forgets the in-window trail", () => {
    const settings = opened(COMPLETED, "settings");
    const local = shown(act(settings, { type: "OpenLocalCapabilities" }).state, COMPLETED, "local");
    expect(local.flow.nav.trail).toEqual(["settings"]);
    const permissions = shown(local, COMPLETED, "permissions");
    expect(permissions.flow.nav.trail).toEqual([]);
    expect(viewOf(permissions)?.nav).toEqual({ back: null, later: true });
  });
});

describe("entry: the window on a completed install", () => {
  test("the server is the home view; open SubKit is the next action", () => {
    const state = opened(COMPLETED, "connect");
    expect(viewOf(state)?.screen).toMatchObject({ kind: "server", profileId: "p1" });
    expect(viewOf(state)?.nav).toBeNull();
    expect(act(state, { type: "OpenSubKit" }).effects).toEqual([
      { kind: "openProfile", profileId: "p1" },
    ]);
  });

  test("another server unfolds the form, back folds it again", () => {
    const other = act(opened(COMPLETED, "connect"), { type: "ConnectAnotherServer" }).state;
    expect(viewOf(other)?.screen).toMatchObject({ kind: "connect", back: true, address: "" });
    expect(viewOf(other)?.frame.dots.visible).toBe(false);
    const back = act(other, { type: "GoBack" });
    expect(back.events).toEqual([{ type: "OtherServerClosed" }]);
    expect(viewOf(back.state)?.screen.kind).toBe("server");
  });
});
