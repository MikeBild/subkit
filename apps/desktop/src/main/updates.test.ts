import { describe, expect, mock, test } from "bun:test";
import type { UpdateState } from "../shared/updates.ts";

type Listener = (value: { version?: string; percent?: number }) => void;

class FakeUpdater {
  private readonly listeners = new Map<string, Listener>();
  checks = 0;
  installs = 0;
  on(name: string, listener: Listener) {
    this.listeners.set(name, listener);
    return this;
  }
  emit(name: string, value: { version?: string; percent?: number } = {}) {
    this.listeners.get(name)?.(value);
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

Object.assign(globalThis, { SUBKIT_DESKTOP_UPDATES: true });

mock.module("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.1.0" },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  shell: { trashItem: async () => {} },
  utilityProcess: { fork: () => null },
}));
mock.module("electron-updater", () => ({ autoUpdater: updater }));
mock.module("./channel.ts", () => ({ CHANNEL: { channel: "production" } }));
mock.module("./app-log.ts", () => ({ appLog: { info: () => {}, warn: () => {} } }));

const { UpdateController } = await import("./updates.ts");
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
