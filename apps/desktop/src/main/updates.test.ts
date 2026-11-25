import { describe, expect, mock, test } from "bun:test";
import type { UpdateState } from "../shared/updates.ts";

type Listener = (value: { version?: string; percent?: number }) => void;

class FakeUpdater {
  private readonly listeners = new Map<string, Listener>();
  checks = 0;
  installs = 0;
  trail: string[] = [];
  on(name: string, listener: Listener) {
    this.listeners.set(name, listener);
    return this;
  }
  emit(name: string, value: { version?: string; percent?: number } = {}) {
    this.listeners.get(name)?.(value);
    if (name === "update-downloaded") this.trail.push("native-check");
  }
  async checkForUpdates() {
    this.checks += 1;
    return null;
  }
  quitAndInstall() {
    this.installs += 1;
  }
}

const updater = new FakeUpdater();
const prompts: { parent: unknown }[] = [];

Object.assign(globalThis, { SUBKIT_DESKTOP_UPDATES: true });

mock.module("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.1.0" },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      prompts.push({ parent: args.length > 1 ? args[0] : null });
      updater.trail.push("prompt");
      return { response: 1 };
    },
  },
  shell: { trashItem: async () => {} },
  utilityProcess: { fork: () => null },
}));
mock.module("electron-updater", () => ({ autoUpdater: updater }));
mock.module("./channel.ts", () => ({ CHANNEL: { channel: "production" } }));
mock.module("./app-log.ts", () => ({ appLog: { info: () => {}, warn: () => {} } }));

const { UpdateController, updateDiagnostics } = await import("./updates.ts");
const { UpdateFlow } = await import("./update-flow.ts");

async function readyController() {
  const states: UpdateState[] = [];
  const controller = new UpdateController({
    onState: (state) => states.push(state),
    onError: () => {},
  });
  await controller.start();
  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "0.2.0" });
  updater.emit("download-progress", { percent: 40 });
  return { controller, states };
}

describe("the update controller guards a pending install", () => {
  test("ignores new checks while an update downloads", async () => {
    const { controller } = await readyController();
    const before = updater.checks;
    await controller.check();
    updater.emit("checking-for-update");
    updater.emit("update-not-available");
    expect(updater.checks).toBe(before);
    expect(controller.current).toEqual({ phase: "downloading", version: "0.2.0", percent: 40 });
  });

  test("queues exactly one restart and ignores every later click and check", async () => {
    const { controller } = await readyController();
    updater.emit("update-downloaded", { version: "0.2.0" });
    const installs = updater.installs;
    expect(controller.restart()).toBe(true);
    expect(controller.current).toEqual({ phase: "installing", version: "0.2.0" });
    expect(controller.restart()).toBe(true);
    const checks = updater.checks;
    await controller.check();
    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "0.3.0" });
    expect(updater.installs).toBe(installs + 1);
    expect(updater.checks).toBe(checks);
    expect(controller.current).toEqual({ phase: "installing", version: "0.2.0" });
  });

  test("refuses a restart before an update is downloaded", async () => {
    const { controller } = await readyController();
    const installs = updater.installs;
    expect(controller.restart()).toBe(false);
    expect(updater.installs).toBe(installs);
  });
});

describe("the update flow keeps one queued restart", () => {
  test("a second restart click while the first waits for confirmation does nothing", async () => {
    let confirm: (go: boolean) => void = () => {};
    const calls = { confirm: 0, beforeQuit: 0, cancelQuit: 0 };
    const flow = new UpdateFlow({
      locale: () => "de",
      announce: () => {},
      render: () => {},
      showSettings: () => {},
      confirmRestart: () => {
        calls.confirm += 1;
        return new Promise<boolean>((resolve) => {
          confirm = resolve;
        });
      },
      beforeQuit: () => {
        calls.beforeQuit += 1;
      },
      cancelQuit: () => {
        calls.cancelQuit += 1;
      },
      onError: () => {},
    });
    await flow.start();
    updater.emit("update-downloaded", { version: "0.2.0" });
    const installs = updater.installs;
    await flow.runAction();
    await flow.runAction();
    expect(calls.confirm).toBe(1);
    confirm(true);
    await Promise.resolve();
    await Promise.resolve();
    await flow.runAction();
    expect(calls).toEqual({ confirm: 1, beforeQuit: 1, cancelQuit: 0 });
    expect(updater.installs).toBe(installs + 1);
  });
});

describe("the update flow offers the restart after the native hand-off", () => {
  test("opens the ready prompt only after the downloaded event returns, attached to a window", async () => {
    const parent = { id: "connect" };
    const flow = new UpdateFlow({
      locale: () => "de",
      announce: () => {},
      render: () => {},
      showSettings: () => {},
      confirmRestart: async () => false,
      beforeQuit: () => {},
      cancelQuit: () => {},
      onError: () => {},
      dialogParent: () => parent as never,
    });
    await flow.start();
    await new Promise((resolve) => setImmediate(resolve));
    prompts.length = 0;
    updater.trail = [];
    updater.emit("update-downloaded", { version: "0.4.0" });
    expect(prompts).toHaveLength(0);
    expect(updater.trail).toEqual(["native-check"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(updater.trail).toEqual(["native-check", "prompt"]);
    expect(prompts).toEqual([{ parent }]);
  });
});

describe("the update controller records diagnostics around the install", () => {
  test("reports the last attempt once, logs the download and marks before the install", async () => {
    const trail: string[] = [];
    const controller = new UpdateController(
      { onState: () => {}, onError: () => {} },
      {
        previousAttempt: () => trail.push("previous"),
        downloaded: (version) => trail.push(`downloaded:${version}`),
        beforeInstall: (version) => trail.push(`before:${version}:${updater.installs}`),
      },
    );
    await controller.start();
    await controller.start();
    updater.emit("update-downloaded", { version: "0.5.0" });
    const installs = updater.installs;
    expect(controller.restart()).toBe(true);
    expect(trail).toEqual(["previous", "downloaded:0.5.0", `before:0.5.0:${installs}`]);
    expect(updater.installs).toBe(installs + 1);
  });

  test("keeps the update running when a diagnostics step throws", () => {
    const warnings: string[] = [];
    const diagnostics = updateDiagnostics(
      () => {
        throw new Error("no user data");
      },
      undefined,
      { info: () => {}, warn: (event) => warnings.push(event) },
    );
    diagnostics.previousAttempt();
    diagnostics.downloaded("0.5.0");
    diagnostics.beforeInstall("0.5.0");
    expect(warnings).toEqual([
      "update.diagnostics_failed",
      "update.diagnostics_failed",
      "update.diagnostics_failed",
    ]);
  });
});
