import { describe, expect, test } from "bun:test";
import { dictionary, type MessageKey, messageKeys } from "../../shared/i18n.ts";
import {
  type CheckResult,
  type CheckStatus,
  type ConnectState,
  LOCAL_UNAVAILABLE,
  type ProfileSummary,
} from "../../shared/ipc.ts";
import {
  chooseWorkspace,
  completeStep,
  LOADING_ONBOARDING,
  NO_ONBOARDING,
  startOnboarding,
} from "../../shared/onboarding.ts";
import {
  type CheckSlot,
  EXAMPLE_ADDRESS,
  exampleAddresses,
  type FlowUi,
  factsFor,
  fieldError,
  forcedStep,
  hostOf,
  INITIAL_FLOW,
  type Outcome,
  type Problem,
  permissionSetupFor,
  type Screen,
  screenFor,
  signInFor,
  slotFor,
} from "./screens-model.ts";
import { frameFor, stepIndex } from "./steps-model.ts";

const APP = "11.2.0";
const ORIGIN = "https://subkit.example.com";

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

function done(status: CheckStatus, extra: Partial<CheckResult> = {}): CheckSlot {
  return { phase: "done", result: result(status, extra) };
}

function outcome(check: CheckSlot, address = ""): Outcome {
  const slot = slotFor(check, APP, address);
  if (slot.kind !== "outcome") throw new Error(`expected an outcome, got ${slot.kind}`);
  return slot.outcome;
}

function problem(check: CheckSlot, address = ""): Problem {
  const found = outcome(check, address);
  if (found.kind !== "problem") throw new Error(`expected a problem, got ${found.kind}`);
  return found.problem;
}

const CONNECT: FlowUi = { ...INITIAL_FLOW, step: "connect" };

const profile: ProfileSummary = {
  id: "p1",
  label: "work.example.com",
  serverOrigin: "https://work.example.com",
  signedIn: false,
  active: true,
};

function connectState(patch: Partial<ConnectState> = {}): ConnectState {
  return {
    appVersion: APP,
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
    ...patch,
  };
}

function connectScreen(screen: Screen): Extract<Screen, { kind: "connect" }> {
  if (screen.kind !== "connect") throw new Error(`expected connect, got ${screen.kind}`);
  return screen;
}

const RESULT_STATUSES: CheckStatus[] = [
  "compatible",
  "server-too-old",
  "app-too-old",
  "login-unsupported",
  "unreachable",
  "not-subkit",
];

describe("connect flow: server check", () => {
  test("shows the host without scheme and keeps a port", () => {
    expect(hostOf(ORIGIN)).toBe("subkit.example.com");
    expect(hostOf("http://localhost:3000")).toBe("localhost:3000");
    expect(hostOf("subkit.example.com/")).toBe("subkit.example.com");
  });

  test("offers known servers and the one example address, never invented ones", () => {
    expect(exampleAddresses([])).toEqual([EXAMPLE_ADDRESS]);
    expect(exampleAddresses([profile, { ...profile, id: "p2" }])).toEqual([
      "work.example.com",
      EXAMPLE_ADDRESS,
    ]);
  });

  test("an address problem is a field error and leaves the slot empty", () => {
    for (const status of ["empty", "invalid", "insecure", "credentials"] as const) {
      expect(fieldError(done(status))).toBe(`field.${status}`);
      expect(outcome(done(status)).kind).toBe("idle");
    }
    expect(fieldError(done("unreachable"))).toBeNull();
    expect(fieldError({ phase: "checking", requestId: 1 })).toBeNull();
  });

  test("idle leaves an empty slot, checking a skeleton of the same shape", () => {
    expect(outcome({ phase: "idle" })).toEqual({ kind: "idle" });
    expect(slotFor({ phase: "checking", requestId: 1 }, APP)).toEqual({ kind: "checking" });
  });

  test("a compatible server is fine and carries only its version", () => {
    expect(outcome(done("compatible"))).toEqual({ kind: "ok", version: "11.2.0" });
  });

  test("an unreachable server is a danger card with the host, retry and the example", () => {
    const model = problem(done("unreachable"));
    expect(model).toMatchObject({
      tone: "danger",
      title: "slot.unreachable",
      body: "slot.unreachable.help",
      meta: "subkit.example.com",
      example: EXAMPLE_ADDRESS,
      ask: null,
    });
    expect(model.facts).toEqual([
      { label: "err.code", value: "unreachable" },
      { label: "err.url", value: ORIGIN },
    ]);
  });

  test("the example is not offered when the example itself did not answer", () => {
    expect(problem(done("unreachable", { origin: "http://localhost:3000" })).example).toBeNull();
  });

  test("a server that is too old asks the admin with both versions", () => {
    const model = problem(done("server-too-old", { serverVersion: "10.4.0" }));
    expect(model).toMatchObject({
      tone: "warning",
      title: "notice.server-too-old",
      body: "notice.server-too-old.body",
      vars: { version: "10.4.0", needs: "11.2.0" },
      ask: { host: "subkit.example.com", version: "10.4.0", needs: "11.2.0" },
      example: null,
    });
  });

  test("an app that is too old names both versions in the technical detail", () => {
    const model = problem(done("app-too-old", { minAppVersion: "12.0.0" }));
    expect(model.tone).toBe("warning");
    expect(model.facts.slice(2)).toEqual([
      { label: "err.app", value: APP },
      { label: "err.needs", value: "12.0.0" },
    ]);
  });

  test("a check that throws counts as unreachable at the typed address", () => {
    expect(problem({ phase: "failed" }, "unknown.example.org")).toMatchObject({
      tone: "danger",
      title: "slot.unreachable",
      meta: "unknown.example.org",
      example: EXAMPLE_ADDRESS,
    });
  });

  test("every key a result or a sign-in failure uses exists", () => {
    const keys = new Set<MessageKey>(messageKeys());
    for (const status of RESULT_STATUSES) {
      const model = outcome(done(status));
      if (model.kind !== "problem") continue;
      const { title, body, facts } = model.problem;
      for (const key of [title, body, ...facts.map((fact) => fact.label)])
        expect(keys.has(key)).toBe(true);
    }
    for (const reason of [
      "cancelled",
      "expired",
      "rejected",
      "outdated",
      "unreachable",
      "browser-failed",
    ] as const) {
      const model = signInFor({ phase: "failed", origin: ORIGIN, reason }, ORIGIN);
      if (model.phase !== "failed") throw new Error("expected a failure");
      expect(keys.has(model.strip.title)).toBe(true);
    }
  });
});

describe("connect flow: sign-in", () => {
  test("only phases of the same server count", () => {
    expect(signInFor({ phase: "waiting", origin: "https://other.example" }, ORIGIN)).toEqual({
      phase: "ready",
    });
    expect(signInFor({ phase: "waiting", origin: ORIGIN }, ORIGIN)).toEqual({ phase: "waiting" });
    expect(signInFor({ phase: "exchanging", origin: ORIGIN }, ORIGIN)).toEqual({
      phase: "exchanging",
    });
  });

  test("a cancelled sign-in is a short warning without technical detail", () => {
    const model = signInFor({ phase: "failed", origin: ORIGIN, reason: "cancelled" }, ORIGIN);
    if (model.phase !== "failed") throw new Error("expected a failure");
    expect(model.strip).toEqual({
      tone: "warning",
      title: "signin.failed.cancelled",
      vars: {},
      action: null,
    });
    expect(model.facts).toEqual([]);
  });

  test("a rejected sign-in is an error with its code", () => {
    const model = signInFor({ phase: "failed", origin: ORIGIN, reason: "rejected" }, ORIGIN);
    if (model.phase !== "failed") throw new Error("expected a failure");
    expect(model.strip.tone).toBe("danger");
    expect(model.facts).toEqual([{ label: "err.code", value: "rejected" }]);
  });

  test("a running sign-in moves the window to the sign-in step for that server", () => {
    const waiting = connectState({ login: { phase: "waiting", origin: ORIGIN } });
    const ui = forcedStep(waiting, INITIAL_FLOW);
    expect(ui.step).toBe("signin");
    expect(ui.target?.origin).toBe(ORIGIN);
    const screen = screenFor(waiting, ui);
    expect(screen.kind === "signin" && screen.signin.phase).toBe("waiting");
  });

  test("Next is open only after a compatible check", () => {
    const ok: FlowUi = { ...CONNECT, check: done("compatible") };
    expect(connectScreen(screenFor(connectState(), ok)).canContinue).toBe(true);
    const old: FlowUi = { ...CONNECT, check: done("server-too-old") };
    expect(connectScreen(screenFor(connectState(), old)).canContinue).toBe(false);
  });

  test("a finished sign-in shows the confirmation with server, version and device", () => {
    const screen = screenFor(
      connectState({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" } }),
      { ...INITIAL_FLOW, step: "signin", target: { origin: ORIGIN, serverVersion: "11.2.0" } },
    );
    expect(screen).toEqual({
      kind: "signed-in",
      profileId: "p1",
      host: "subkit.example.com",
      serverVersion: "11.2.0",
      device: "MacBook-Anna",
    });
    expect(stepIndex(screen, "server")).toBe(5);
    expect(frameFor(screen).dots).toEqual({ visible: true, current: 5, total: 6 });
  });

  test("while the first-run questions load, the sign-in step shows you are signed in", () => {
    const signedIn = { profileId: "p1", origin: profile.serverOrigin, serverVersion: "11.2.0" };
    const screen = screenFor(
      connectState({ signedIn, onboarding: LOADING_ONBOARDING }),
      INITIAL_FLOW,
    );
    expect(screen).toEqual({
      kind: "signin",
      origin: profile.serverOrigin,
      host: "work.example.com",
      signin: { phase: "done", serverVersion: "11.2.0" },
      joining: false,
    });
    expect(frameFor(screen).dots).toEqual({ visible: true, current: 1, total: 6 });
  });

  test("after sign-in the first-run steps come before the device, the dot count stays", () => {
    const signedIn = { profileId: "p1", origin: profile.serverOrigin, serverVersion: "11.2.0" };
    const workspaces = [
      { tenantId: "t1", name: "Bild Consulting", role: "admin", owner: true },
      { tenantId: "t2", name: "Harmoniqs", role: "member", owner: false },
    ];
    const onboarding = startOnboarding(workspaces, {
      notificationsAsked: false,
      diagnosticsAsked: false,
    });
    const screen = screenFor(connectState({ signedIn, onboarding }), INITIAL_FLOW);
    expect(screen).toEqual({ kind: "workspace", workspaces, failed: false });
    expect(frameFor(screen).dots).toEqual({ visible: true, current: 2, total: 6 });
    const chosen = chooseWorkspace(onboarding, "t1");
    const notifications = screenFor(connectState({ signedIn, onboarding: chosen }), INITIAL_FLOW);
    expect(notifications).toEqual({ kind: "consent", topic: "notifications", choice: null });
    expect(frameFor(notifications).dots.current).toBe(3);
    const next = completeStep(chosen, "notifications");
    const flow: FlowUi = { ...INITIAL_FLOW, consent: { notifications: true, diagnostics: false } };
    const diagnostics = screenFor(connectState({ signedIn, onboarding: next }), flow);
    expect(diagnostics).toEqual({ kind: "consent", topic: "diagnostics", choice: false });
    expect(frameFor(diagnostics).dots.current).toBe(4);
    const finished = completeStep(next, "diagnostics");
    const device = screenFor(connectState({ signedIn, onboarding: finished }), INITIAL_FLOW);
    expect(device.kind).toBe("signed-in");
    expect(frameFor(device).dots).toEqual({ visible: true, current: 5, total: 6 });
  });

  test("a skipped first-run step keeps the dot count and is passed over", () => {
    const signedIn = { profileId: "p1", origin: profile.serverOrigin, serverVersion: "11.2.0" };
    const onboarding = startOnboarding([], { notificationsAsked: false, diagnosticsAsked: true });
    const screen = screenFor(connectState({ signedIn, onboarding }), INITIAL_FLOW);
    expect(screen.kind === "consent" && screen.topic).toBe("notifications");
    expect(frameFor(screen).dots).toEqual({ visible: true, current: 3, total: 6 });
  });
});

describe("connect flow: notices from the main process", () => {
  test("an expired session asks to sign in again to the same server", () => {
    const state = connectState({
      profiles: [profile],
      notice: { kind: "expired", profileId: "p1" },
    });
    const ui = forcedStep(state, INITIAL_FLOW);
    expect(ui.step).toBe("connect");
    const screen = screenFor(state, ui);
    expect(screen.kind === "relogin" && screen.origin).toBe(profile.serverOrigin);
    expect(stepIndex(screen, "server")).toBeNull();
    const waiting = {
      ...state,
      login: { phase: "waiting" as const, origin: profile.serverOrigin },
    };
    expect(forcedStep(waiting, CONNECT)).toBe(CONNECT);
    const relogin = screenFor(waiting, CONNECT);
    expect(relogin.kind === "relogin" && relogin.signin.phase).toBe("waiting");
  });

  test("connecting another server leaves the relogin screen", () => {
    const state = connectState({
      profiles: [profile],
      notice: { kind: "expired", profileId: "p1" },
    });
    expect(screenFor(state, { ...CONNECT, reloginDismissed: true }).kind).toBe("connect");
  });

  test("a revoked device is a warning with an explanation, its code and the server", () => {
    const state = connectState({
      profiles: [profile],
      notice: { kind: "revoked", profileId: "p1" },
    });
    expect(connectScreen(screenFor(state, CONNECT)).strip).toEqual({
      tone: "warning",
      title: "strip.revoked",
      vars: { host: "work.example.com" },
      body: "strip.revoked.body",
      facts: [
        { label: "err.code", value: "installation_revoked" },
        { label: "err.url", value: profile.serverOrigin },
      ],
      action: {
        label: "strip.revoked.action",
        action: { kind: "sign-in", origin: profile.serverOrigin },
      },
    });
  });

  test("an offline server retries by opening the profile", () => {
    const state = connectState({
      profiles: [profile],
      notice: { kind: "offline", profileId: "p1" },
    });
    const { strip } = connectScreen(screenFor(state, CONNECT));
    expect(strip?.tone).toBe("danger");
    expect(strip?.action?.action).toEqual({ kind: "open-profile", profileId: "p1" });
  });

  test("the settings view wins over every step", () => {
    expect(screenFor(connectState({ view: "settings" }), INITIAL_FLOW).kind).toBe("settings");
  });

  test("the permission setup shows both cards outside the steps", () => {
    const screen = screenFor(connectState({ view: "permissions" }), INITIAL_FLOW);
    expect(screen).toEqual({
      kind: "permissions",
      setup: {
        supported: true,
        cards: [
          { key: "accessibility", granted: false, restart: false },
          { key: "screen", granted: false, restart: false },
        ],
        done: false,
        lost: false,
      },
    });
    expect(frameFor(screen)).toEqual({
      dots: { visible: false, current: 0, total: 6 },
      settingsOpen: false,
    });
  });

  test("a granted Screen Recording waits for the restart and a lost permission is flagged", () => {
    expect(
      permissionSetupFor({
        supported: true,
        permissions: { accessibility: true, screen: true, restartPending: true },
        lost: ["accessibility"],
      }),
    ).toEqual({
      supported: true,
      cards: [
        { key: "accessibility", granted: true, restart: false },
        { key: "screen", granted: false, restart: true },
      ],
      done: false,
      lost: true,
    });
    expect(
      permissionSetupFor({
        supported: false,
        permissions: { accessibility: true, screen: true, restartPending: false },
        lost: [],
      }),
    ).toMatchObject({ supported: false, done: true, lost: false });
  });
});

describe("welcome", () => {
  test("a first start without servers opens on welcome, with the invitation field closed", () => {
    expect(screenFor(connectState(), INITIAL_FLOW)).toEqual({
      kind: "welcome",
      invite: { open: false, link: "", checking: false, error: null },
    });
  });

  test("with a known server the window starts on the connect step, without a way back", () => {
    const state = connectState({ profiles: [profile] });
    const ui = forcedStep(state, INITIAL_FLOW);
    expect(ui.step).toBe("connect");
    expect(connectScreen(screenFor(state, ui)).back).toBe(false);
    expect(connectScreen(screenFor(connectState(), CONNECT)).back).toBe(true);
  });
});

describe("compactness: each fact once, details collapsed to what matters", () => {
  test("technical detail starts with the code and the tried address, from the catalog", () => {
    const statuses = ["server-too-old", "app-too-old", "login-unsupported", "not-subkit"] as const;
    for (const status of statuses) {
      const model = problem(done(status));
      expect(model.facts.slice(0, 2).map((fact) => fact.label)).toEqual(["err.code", "err.url"]);
      expect(model.facts[1]?.value).toBe(ORIGIN);
    }
    expect(factsFor("serverTooOld", null)).toEqual([
      { label: "err.code", value: "server_too_old" },
    ]);
  });

  test("only a server that does not answer offers the example, only a too-old one asks", () => {
    for (const status of RESULT_STATUSES) {
      const model = outcome(done(status));
      if (model.kind !== "problem") continue;
      const danger = status === "unreachable" || status === "not-subkit";
      expect(model.problem.example !== null).toBe(danger);
      expect(model.problem.ask !== null).toBe(status === "server-too-old");
    }
  });

  test("a result shows the host once, never the full address outside the technical detail", () => {
    for (const status of RESULT_STATUSES) {
      const model = outcome(done(status));
      if (model.kind !== "problem") continue;
      expect(model.problem.meta).toBe("subkit.example.com");
      expect(Object.values(model.problem.vars)).not.toContain(ORIGIN);
    }
  });

  test("the signed-in screen holds only server, version and device, without a badge", () => {
    const screen = screenFor(
      connectState({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: "11.2.0" } }),
      INITIAL_FLOW,
    );
    expect(Object.keys(screen).sort()).toEqual(
      ["device", "host", "kind", "profileId", "serverVersion"].sort(),
    );
  });

  test("the connect screen carries the typed address and the running check", () => {
    const flow: FlowUi = {
      ...CONNECT,
      address: "work",
      check: { phase: "checking", requestId: 4 },
    };
    const screen = connectScreen(screenFor(connectState(), flow));
    expect(screen.address).toBe("work");
    expect(screen.checking).toBe(true);
    expect(screen.slot).toEqual({ kind: "checking" });
  });
});

describe("window frame", () => {
  test("the steps show their dot, welcome, relogin and settings hide the dots", () => {
    expect(frameFor(screenFor(connectState(), CONNECT)).dots).toEqual({
      visible: true,
      current: 0,
      total: 6,
    });
    expect(frameFor(screenFor(connectState(), INITIAL_FLOW)).dots.visible).toBe(false);
    const signedIn = screenFor(
      connectState({ signedIn: { profileId: "p1", origin: ORIGIN, serverVersion: null } }),
      INITIAL_FLOW,
    );
    expect(frameFor(signedIn).dots.current).toBe(5);
    const expired = connectState({
      profiles: [profile],
      notice: { kind: "expired", profileId: "p1" },
    });
    expect(frameFor(screenFor(expired, CONNECT)).dots.visible).toBe(false);
  });

  test("settings mark the toggle as pressed", () => {
    const frame = frameFor(screenFor(connectState({ view: "settings" }), INITIAL_FLOW));
    expect(frame).toEqual({ dots: { visible: false, current: 0, total: 6 }, settingsOpen: true });
  });
});
