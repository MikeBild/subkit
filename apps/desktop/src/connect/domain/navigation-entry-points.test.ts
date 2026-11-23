import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import {
  type ConnectState,
  type ConnectView,
  LOCAL_UNAVAILABLE,
  type ProfileSummary,
} from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import { CLOSED_REPORT } from "../../shared/problem-report.ts";
import {
  DIRECT_VIEWS,
  EMPTY_TRAIL,
  navigated,
  returnTarget,
  viewChanged,
  wentBack,
  wentHome,
} from "./navigation-model.ts";
import type { Screen } from "./screens-model.ts";
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
  label: "work.example.com",
  serverOrigin: "https://work.example.com",
  signedIn: true,
  active: true,
};

function main(base: Partial<ConnectState>, view: ConnectView): ConnectState {
  return {
    appVersion: "12.1.5",
    deviceLabel: "Office laptop",
    locale: "en",
    messages: dictionary("en"),
    view,
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
    update: { phase: "idle" },
    permissions: {
      supported: true,
      permissions: { accessibility: true, screen: false, restartPending: false },
      lost: [],
    },
    local: LOCAL_UNAVAILABLE,
    platform: platformCapabilities("darwin", "arm64"),
    defaultServer: "https://work.example.com",
    report: { ...CLOSED_REPORT, host: "work.example.com" },
    ...base,
  };
}

interface Entry {
  name: string;
  base: Partial<ConnectState>;
  home: Effect[];
  homeScreen: Screen["kind"];
}

const TO_COCKPIT: Effect[] = [
  { kind: "showView", view: "connect" },
  { kind: "openProfile", profileId: "p1" },
];
const TO_WIZARD: Effect[] = [{ kind: "showView", view: "connect" }];

const FIRST_RUN: Entry = { name: "first run", base: {}, home: TO_WIZARD, homeScreen: "welcome" };
const SETTLED: Entry = {
  name: "settled",
  base: { profiles: [SIGNED_IN] },
  home: TO_COCKPIT,
  homeScreen: "server",
};
const ENTRIES = [FIRST_RUN, SETTLED];

function opened(entry: Entry, view: ConnectView): SignInState {
  return evolve(INITIAL_STATE, { type: "MainStateReceived", state: main(entry.base, view) });
}

function shown(state: SignInState, entry: Entry, view: ConnectView): SignInState {
  return evolve(state, { type: "MainStateReceived", state: main(entry.base, view) });
}

function act(state: SignInState, command: Command) {
  const decision = decide(state, command, { requestId: 1 });
  return { ...decision, state: evolveAll(state, decision.events) };
}

function follow(state: SignInState, entry: Entry, command: Command) {
  const step = act(state, command);
  const target = step.effects.find((effect) => effect.kind === "showView");
  const view = target?.kind === "showView" ? target.view : (state.main?.view ?? "connect");
  const reportOpened = step.effects.some((effect) => effect.kind === "reportProblem");
  return {
    effects: step.effects,
    state: shown(step.state, entry, reportOpened ? "report" : view),
  };
}

const CLOSE: Partial<Record<ConnectView, Command>> = {
  settings: { type: "GoBack" },
  local: { type: "GoBack" },
  permissions: { type: "GoBack" },
  report: { type: "CloseReport" },
};

const FORWARD: { from: ConnectView; command: Command; to: ConnectView }[] = [
  { from: "connect", command: { type: "ToggleSettings" }, to: "settings" },
  { from: "settings", command: { type: "OpenLocalCapabilities" }, to: "local" },
  { from: "local", command: { type: "OpenPermissions" }, to: "permissions" },
  { from: "settings", command: { type: "ReportProblem" }, to: "report" },
  { from: "local", command: { type: "ReportProblem" }, to: "report" },
  { from: "connect", command: { type: "ReportProblem" }, to: "report" },
];

describe("tray: every direct view opened from outside the window has a way back", () => {
  for (const entry of ENTRIES)
    for (const view of DIRECT_VIEWS)
      test(`${entry.name} › ${view}`, () => {
        const state = opened(entry, view);
        const nav = viewOf(state)?.nav;
        expect(nav).not.toBeNull();
        expect(nav?.back !== null || nav?.later === true).toBe(true);
        if (nav?.back) {
          expect(dictionary("de")[nav.back]).toBeTruthy();
          expect(dictionary("en")[nav.back]).toBeTruthy();
        }
        const close = view === "permissions" ? { type: "ClosePermissions" as const } : CLOSE[view];
        if (!close) throw new Error(`no close for ${view}`);
        expect(act(state, close).effects).toEqual(entry.home);
      });
});

describe("tray: the close label matches where the person lands", () => {
  test("settled lands in the Cockpit, so the label says close", () => {
    for (const view of ["settings", "local", "report"] as const)
      expect(viewOf(opened(SETTLED, view))?.nav?.back).toBe("common.close");
  });

  test("first run lands in the wizard, so the label says back", () => {
    for (const view of ["settings", "local", "report"] as const)
      expect(viewOf(opened(FIRST_RUN, view))?.nav?.back).toBe("common.back");
  });

  test("permissions from outside offer later instead of a back arrow", () => {
    for (const entry of ENTRIES)
      expect(viewOf(opened(entry, "permissions"))?.nav).toEqual({ back: null, later: true });
  });
});

describe("forward then back returns to the view it came from", () => {
  for (const entry of ENTRIES)
    for (const { from, command, to } of FORWARD)
      test(`${entry.name} › ${from} → ${to} → ${from}`, () => {
        const start = from === "connect" ? opened(entry, "connect") : opened(entry, from);
        const ahead = follow(start, entry, command);
        expect(ahead.state.main?.view).toBe(to);
        expect(ahead.state.flow.nav.trail.at(-1)).toBe(from);
        expect(viewOf(ahead.state)?.nav).toEqual({ back: "common.back", later: false });
        const close = CLOSE[to] ?? { type: "GoBack" };
        const back = follow(ahead.state, entry, close);
        expect(back.effects).toEqual([{ kind: "showView", view: from }]);
        expect(back.state.main?.view).toBe(from);
        expect(back.state.flow.nav.trail).toEqual(start.flow.nav.trail);
      });
});

describe("a deep chain unwinds one view at a time and ends at home", () => {
  for (const entry of ENTRIES)
    test(entry.name, () => {
      let state = opened(entry, "connect");
      for (const command of [
        { type: "ToggleSettings" },
        { type: "OpenLocalCapabilities" },
        { type: "OpenPermissions" },
      ] as const)
        state = follow(state, entry, command).state;
      expect(state.flow.nav.trail).toEqual(["connect", "settings", "local"]);
      const visited: ConnectView[] = [];
      for (let step = 0; step < 3; step += 1) {
        const back = follow(state, entry, { type: "GoBack" });
        state = back.state;
        visited.push(state.main?.view ?? "connect");
      }
      expect(visited).toEqual(["local", "settings", "connect"]);
      expect(state.flow.nav.trail).toEqual([]);
      expect(viewOf(state)?.screen.kind).toBe(entry.homeScreen);
      expect(viewOf(state)?.nav).toBeNull();
    });
});

describe("deep link: subkit://open lands on the home view with nothing to go back to", () => {
  for (const entry of ENTRIES)
    test(entry.name, () => {
      const state = opened(entry, "connect");
      const view = viewOf(state);
      expect(view?.screen.kind).toBe(entry.homeScreen);
      expect(view?.nav).toBeNull();
      expect(state.flow.nav).toEqual(EMPTY_TRAIL);
    });

  test("a deep link that arrives while settings are open forgets the in-window trail", () => {
    const settings = follow(opened(SETTLED, "connect"), SETTLED, { type: "ToggleSettings" }).state;
    expect(settings.flow.nav.trail).toEqual(["connect"]);
    const linked = shown(settings, SETTLED, "connect");
    expect(linked.flow.nav).toEqual(EMPTY_TRAIL);
    expect(viewOf(linked)?.screen.kind).toBe("server");
  });

  test("a failed sign-in callback during the first run returns to the wizard, not to a view", () => {
    const failed = shown(opened(FIRST_RUN, "settings"), FIRST_RUN, "connect");
    expect(failed.flow.nav).toEqual(EMPTY_TRAIL);
    expect(viewOf(failed)?.nav).toBeNull();
    expect(viewOf(failed)?.frame.dots.visible).toBe(false);
  });
});

describe("the navigation trail itself", () => {
  test("forward pushes the origin and back pops it", () => {
    const ahead = navigated(EMPTY_TRAIL, "settings", "local");
    expect(ahead).toEqual({ trail: ["settings"], requested: "local" });
    const landed = viewChanged(ahead, "settings", "local");
    expect(landed).toEqual({ trail: ["settings"], requested: null });
    const back = wentBack(landed, "settings");
    expect(back).toEqual({ trail: [], requested: "settings" });
    expect(viewChanged(back, "local", "settings")).toEqual(EMPTY_TRAIL);
  });

  test("going forward to the view already shown changes nothing", () => {
    expect(navigated(EMPTY_TRAIL, "settings", "settings")).toBe(EMPTY_TRAIL);
  });

  test("an empty trail always resolves back to home, never to a missing view", () => {
    for (const entry of ENTRIES)
      for (const view of [...DIRECT_VIEWS, "connect" as const]) {
        const target = returnTarget(main(entry.base, view), EMPTY_TRAIL);
        expect(target.kind).toBe(entry === SETTLED ? "cockpit" : "wizard");
      }
  });

  test("home clears the trail and asks for the connect view", () => {
    expect(wentHome()).toEqual({ trail: [], requested: "connect" });
  });
});
