import { describe, expect, test } from "bun:test";
import { dictionary } from "../../shared/i18n.ts";
import { type ConnectState, LOCAL_UNAVAILABLE, type LocalView } from "../../shared/ipc.ts";
import { NO_ONBOARDING } from "../../shared/onboarding.ts";
import { platformCapabilities } from "../../shared/platform-capabilities.ts";
import {
  type Command,
  decide,
  evolveAll,
  INITIAL_STATE,
  type SignInState,
  viewOf,
} from "./index.ts";

const FOLDER = "/Users/anna/Library/Application Support/SubKit";

function local(patch: Partial<LocalView> = {}): LocalView {
  return { ...LOCAL_UNAVAILABLE, available: true, folder: FOLDER, ...patch };
}

function main(patch: Partial<LocalView> = {}): ConnectState {
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
    update: { phase: "idle" },
    permissions: {
      supported: true,
      permissions: { accessibility: false, screen: false, restartPending: false },
      lost: [],
    },
    local: local(patch),
    platform: platformCapabilities("darwin", "arm64"),
  };
}

function received(state: SignInState, patch: Partial<LocalView> = {}): SignInState {
  return evolveAll(state, [{ type: "MainStateReceived", state: main(patch) }]);
}

function run(state: SignInState, command: Command) {
  const decision = decide(state, command, { requestId: 1 });
  return { state: evolveAll(state, decision.events), effects: decision.effects };
}

const opened = () => run(received(INITIAL_STATE), { type: "StartLocalSetup" }).state;

describe("choosing to run SubKit only on this Mac", () => {
  test("the connect step offers it only where local mode is available and not set up", () => {
    const screen = (patch: Partial<LocalView>) =>
      viewOf(
        evolveAll(received(INITIAL_STATE, patch), [{ type: "ConnectStarted", path: "server" }]),
      )?.screen;
    expect(screen({})).toMatchObject({ kind: "connect", localAvailable: true });
    expect(screen({ available: false })).toMatchObject({ localAvailable: false });
    expect(screen({ configured: true })).toMatchObject({ localAvailable: false });
    const refused = run(received(INITIAL_STATE, { available: false }), {
      type: "StartLocalSetup",
    });
    expect(viewOf(refused.state)?.screen.kind).toBe("welcome");
  });

  test("the setup has four steps with their own dots", () => {
    const view = viewOf(opened());
    expect(view?.screen).toMatchObject({ kind: "local", step: 0, folder: FOLDER, starting: false });
    expect(view?.frame.dots).toEqual({ visible: true, current: 0, total: 4 });
  });

  test("leaving the folder step starts the database while the person goes on", () => {
    const next = run(opened(), { type: "LocalNext" });
    expect(next.effects).toEqual([{ kind: "localBegin" }]);
    expect(viewOf(next.state)?.screen).toMatchObject({ kind: "local", step: 1 });
    const ai = run(next.state, { type: "LocalNext" });
    expect(ai.effects).toEqual([]);
    expect(viewOf(ai.state)?.screen).toMatchObject({ step: 2 });
  });

  test("a refused folder blocks the next step and picking another asks main", () => {
    const refused = received(opened(), { folderRefusal: "cloud_synced_folder" });
    expect(run(refused, { type: "LocalNext" }).effects).toEqual([]);
    expect(run(refused, { type: "LocalPickDataFolder" }).effects).toEqual([
      { kind: "localPickDataFolder" },
    ]);
  });

  test("finishing hands name and AI access to main once and shows the phases", () => {
    const atAi = run(run(opened(), { type: "LocalNext" }).state, { type: "LocalNext" }).state;
    const input = {
      name: "Anna",
      ai: { kind: "model" as const, origin: "http://localhost:11434" },
    };
    const finished = run(atAi, { type: "LocalFinish", input });
    expect(finished.effects).toEqual([{ kind: "localFinish", input }]);
    expect(viewOf(finished.state)?.screen).toMatchObject({ step: 3 });
    expect(run(finished.state, { type: "LocalFinish", input }).effects).toEqual([]);
    const working = received(finished.state, {
      working: true,
      progress: { database: true, engine: false, workspace: false },
    });
    const screen = viewOf(working)?.screen;
    expect(screen?.kind === "local" && screen.rows.map((row) => row.state)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(run(working, { type: "LocalOpen" }).effects).toEqual([]);
    const done = received(finished.state, {
      progress: { database: true, engine: true, workspace: true },
    });
    expect(run(done, { type: "LocalOpen" }).effects).toEqual([{ kind: "localOpen" }]);
  });

  test("a rejected key returns to the AI step, a refused folder to the folder step", () => {
    const atAi = run(run(opened(), { type: "LocalNext" }).state, { type: "LocalNext" }).state;
    const input = {
      name: "Anna",
      ai: { kind: "provider" as const, provider: "anthropic" as const, key: "sk-x" },
    };
    const finished = run(atAi, { type: "LocalFinish", input }).state;
    expect(viewOf(received(finished, { error: "keyRejected" }))?.screen).toMatchObject({
      step: 2,
    });
    expect(viewOf(received(finished, { error: "folder" }))?.screen).toMatchObject({ step: 0 });
    expect(viewOf(received(finished, { error: "disk" }))?.screen).toMatchObject({ step: 3 });
  });

  test("back walks the steps and leaving the first step cancels the local start", () => {
    const second = run(opened(), { type: "LocalNext" }).state;
    const back = run(second, { type: "LocalBack" });
    expect(viewOf(back.state)?.screen).toMatchObject({ step: 0 });
    const left = run(back.state, { type: "GoBack" });
    expect(left.effects).toEqual([{ kind: "localCancel" }]);
    expect(viewOf(left.state)?.screen.kind).toBe("connect");
  });

  test("an error offers a retry that starts again", () => {
    const failed = received(opened(), { error: "port" });
    expect(run(failed, { type: "LocalRetry" }).effects).toEqual([{ kind: "localBegin" }]);
    expect(run(received(opened()), { type: "LocalRetry" }).effects).toEqual([]);
  });
});

describe("a local workspace that is starting", () => {
  test("shows only the phases, without dots or a way back", () => {
    const state = received(INITIAL_STATE, { configured: true, attention: true, working: true });
    const view = viewOf(state);
    expect(view?.screen).toMatchObject({ kind: "local", step: 3, starting: true });
    expect(view?.frame.dots.visible).toBe(false);
    expect(run(state, { type: "LocalBack" }).effects).toEqual([]);
  });
});

describe("backups, the move to a server and removing everything", () => {
  const configured = () => received(INITIAL_STATE, { configured: true });
  const server = "https://subkit.example.com";
  const moved = { server, bundle: "/x/exports/b.zip" };

  test("one operation at a time", () => {
    expect(run(configured(), { type: "LocalBackup" }).effects).toEqual([{ kind: "localBackup" }]);
    expect(run(configured(), { type: "LocalRestore", name: "b" }).effects).toEqual([
      { kind: "localRestore", name: "b" },
    ]);
    const busy = received(INITIAL_STATE, { configured: true, busy: "backup" });
    expect(run(busy, { type: "LocalBackup" }).effects).toEqual([]);
    expect(run(busy, { type: "LocalRestore", name: "b" }).effects).toEqual([]);
    expect(run(busy, { type: "LocalMove", serverOrigin: server }).effects).toEqual([]);
    expect(run(busy, { type: "LocalRemoveAll" }).effects).toEqual([]);
  });

  test("the export runs only on the confirmed move and only once", () => {
    expect(run(configured(), { type: "LocalMove", serverOrigin: server }).effects).toEqual([
      { kind: "localMove", serverOrigin: server },
    ]);
    const done = received(INITIAL_STATE, { configured: true, moved });
    expect(run(done, { type: "LocalMove", serverOrigin: server }).effects).toEqual([]);
  });

  test("signing in to the server follows only after the move", () => {
    expect(run(configured(), { type: "LocalMoveSignIn", origin: server }).effects).toEqual([]);
    const done = received(INITIAL_STATE, { configured: true, moved });
    expect(run(done, { type: "LocalMoveSignIn", origin: server }).effects).toEqual([
      { kind: "showView", view: "connect" },
      { kind: "login", origin: server },
    ]);
  });

  test("removing all local data needs a local workspace", () => {
    expect(run(configured(), { type: "LocalRemoveAll" }).effects).toEqual([
      { kind: "localRemoveAll" },
    ]);
    expect(run(received(INITIAL_STATE), { type: "LocalRemoveAll" }).effects).toEqual([]);
  });

  test("a moved workspace does not start again", () => {
    const state = received(INITIAL_STATE, { configured: true, moved, attention: false });
    expect(viewOf(state)?.screen.kind).toBe("welcome");
  });
});
