import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import type { CheckResult, ConnectBridge, ConnectState } from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { createSignInStore } from "./sign-in-store.ts";

const ORIGIN = "https://subkit.example.com";

function main(patch: Partial<ConnectState> = {}): ConnectState {
  return {
    appVersion: "11.2.0",
    deviceLabel: "MacBook-Anna",
    locale: "en",
    messages: dictionary("en"),
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
    ...patch,
  };
}

const compatible: CheckResult = {
  status: "compatible",
  origin: ORIGIN,
  serverVersion: "11.2.0",
  minAppVersion: null,
  minServerVersion: "11.2.0",
};

function stubBridge(
  answers: { check?: () => Promise<CheckResult>; login?: () => Promise<CheckResult> } = {},
) {
  const calls: unknown[][] = [];
  let push: (state: ConnectState) => void = () => {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve();
    };
  const bridge: ConnectBridge = {
    getState: () => Promise.resolve(main()),
    checkServer: (address) => {
      calls.push(["checkServer", address]);
      return answers.check?.() ?? Promise.resolve(compatible);
    },
    login: (origin) => {
      calls.push(["login", origin]);
      return answers.login?.() ?? Promise.resolve(compatible);
    },
    cancelLogin: record("cancelLogin") as ConnectBridge["cancelLogin"],
    openProfile: record("openProfile") as ConnectBridge["openProfile"],
    removeProfile: record("removeProfile") as ConnectBridge["removeProfile"],
    updateSettings: record("updateSettings") as ConnectBridge["updateSettings"],
    showView: record("showView") as ConnectBridge["showView"],
    chooseWorkspace: record("chooseWorkspace") as ConnectBridge["chooseWorkspace"],
    answerNotifications: record("answerNotifications") as ConnectBridge["answerNotifications"],
    answerDiagnostics: record("answerDiagnostics") as ConnectBridge["answerDiagnostics"],
    updateAction: record("updateAction") as ConnectBridge["updateAction"],
    reportProblem: record("reportProblem") as ConnectBridge["reportProblem"],
    checkInvite: (link) => {
      calls.push(["checkInvite", link]);
      return Promise.resolve({ kind: "link" });
    },
    joinInvite: record("joinInvite") as ConnectBridge["joinInvite"],
    onState: (listener) => {
      push = listener;
    },
  };
  return { bridge, calls, push: (state: ConnectState) => push(state) };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("sign-in store over the preload bridge", () => {
  test("the first state from getState becomes the view", async () => {
    const { bridge } = stubBridge();
    const store = createSignInStore(bridge);
    expect(store.getView()).toBeNull();
    await settle();
    expect(store.getView()?.screen.kind).toBe("welcome");
  });

  test("pushed states from the main process are domain events", async () => {
    const stub = stubBridge();
    const store = createSignInStore(stub.bridge);
    await settle();
    stub.push(main({ view: "settings" }));
    expect(store.getView()?.screen.kind).toBe("settings");
  });

  test("a version check calls the bridge once and lands the answer with its id", async () => {
    const stub = stubBridge();
    const store = createSignInStore(stub.bridge, { nextId: () => 41 });
    await settle();
    store.dispatch({ type: "StartConnect" });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().flow.check.phase));
    store.dispatch({ type: "CheckServer", address: "subkit.example.com" });
    expect(store.getState().flow.check).toEqual({ phase: "checking", requestId: 41 });
    await settle();
    expect(stub.calls).toEqual([["checkServer", "subkit.example.com"]]);
    expect(seen).toEqual(["checking", "done"]);
    expect(store.getView()?.screen.kind === "connect" && store.getView()?.screen).toMatchObject({
      canContinue: true,
    });
  });

  test("a check that rejects shows the broken link", async () => {
    const stub = stubBridge({ check: () => Promise.reject(new Error("down")) });
    const store = createSignInStore(stub.bridge);
    await settle();
    store.dispatch({ type: "CheckServer", address: "x" });
    await settle();
    expect(store.getState().flow.check).toEqual({ phase: "failed" });
  });

  test("a refused sign-in returns to the server step, a thrown one changes nothing", async () => {
    const refused: CheckResult = { ...compatible, status: "app-too-old", minAppVersion: "12.0.0" };
    const stub = stubBridge({ login: () => Promise.resolve(refused) });
    const store = createSignInStore(stub.bridge);
    await settle();
    store.dispatch({ type: "StartSignIn", origin: ORIGIN });
    await settle();
    expect(stub.calls).toEqual([["login", ORIGIN]]);
    expect(store.getState().flow.check).toEqual({ phase: "done", result: refused });

    const broken = stubBridge({ login: () => Promise.reject(new Error("ipc")) });
    const other = createSignInStore(broken.bridge);
    await settle();
    const before = other.getState();
    other.dispatch({ type: "StartSignIn", origin: ORIGIN });
    await settle();
    expect(other.getState()).toBe(before);
  });

  test("every other effect is exactly one bridge call", async () => {
    const stub = stubBridge();
    const store = createSignInStore(stub.bridge);
    await settle();
    stub.push(main({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: null } }));
    store.dispatch({ type: "OpenSubKit" });
    store.dispatch({ type: "CancelSignIn" });
    store.dispatch({ type: "RemoveServer", profileId: "p2" });
    store.dispatch({ type: "ToggleSettings" });
    store.dispatch({ type: "ChangeSettings", patch: { locale: "de" } });
    store.dispatch({ type: "RunUpdateAction" });
    store.dispatch({ type: "ReportProblem" });
    expect(stub.calls).toEqual([
      ["openProfile", "p1"],
      ["cancelLogin"],
      ["removeProfile", "p2"],
      ["showView", "settings"],
      ["updateSettings", { locale: "de" }],
      ["updateAction"],
      ["reportProblem"],
    ]);
  });

  test("unsubscribed listeners hear nothing more", async () => {
    const stub = stubBridge();
    const store = createSignInStore(stub.bridge);
    await settle();
    let heard = 0;
    const stop = store.subscribe(() => heard++);
    stub.push(main());
    stop();
    stub.push(main());
    expect(heard).toBe(1);
  });
});
