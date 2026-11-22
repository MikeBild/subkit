import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Listener = (value: unknown) => void;

class FakeChild {
  private readonly listeners = new Map<string, Listener[]>();
  readonly sent: unknown[] = [];
  on(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return this;
  }
  once(name: string, listener: Listener) {
    return this.on(name, listener);
  }
  postMessage(message: unknown) {
    this.sent.push(message);
    if ((message as { type?: string }).type === "shutdown") this.emit("exit", 0);
  }
  kill() {
    this.emit("exit", 1);
  }
  emit(name: string, value: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(value);
  }
}

const children: FakeChild[] = [];

mock.module("electron", () => ({
  shell: { trashItem: async () => {} },
  utilityProcess: {
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  },
}));

const { createRunnerHost } = await import("./runner-host.ts");
const { KeepAwake } = await import("./keep-awake.ts");

function host(awake: InstanceType<typeof KeepAwake>) {
  return createRunnerHost({
    script: "runner.js",
    config: {} as never,
    computer: () => ({}) as never,
    permissions: () => ({}) as never,
    onLive: () => {},
    onBusy: (command_id, busy) =>
      awake.apply({ type: busy ? "step_started" : "step_ended", command_id }),
    onExit: () => awake.apply({ type: "runner_ended" }),
    onProblem: () => {},
    idleSeconds: () => null,
    stopStatePath: join(mkdtempSync(join(tmpdir(), "runner-host-")), "stop.json"),
    files: () => ({}) as never,
    mayTouch: () => false,
    mark: async () => false,
    volumeId: async () => null,
    privateKey: () => null,
    onState: () => {},
    now: () => 0,
  });
}

function fakePower() {
  const active = new Set<number>();
  let next = 1;
  return {
    active,
    start: () => {
      active.add(next);
      return next++;
    },
    stop: (id: number) => {
      active.delete(id);
    },
  };
}

describe("runner host releases the awake hold whenever the runner goes away", () => {
  test("a shutdown in the middle of a step releases it", async () => {
    const power = fakePower();
    const awake = new KeepAwake(power);
    const runner = host(awake);
    runner.start();
    children.at(-1)?.emit("message", { type: "busy", command_id: "c1", busy: true });
    expect(power.active.size).toBe(1);
    await runner.shutdown();
    expect(power.active.size).toBe(0);
  });

  test("a crash in the middle of a step releases it", () => {
    const power = fakePower();
    const awake = new KeepAwake(power);
    const runner = host(awake);
    runner.start();
    const child = children.at(-1);
    child?.emit("message", { type: "busy", command_id: "c2", busy: true });
    expect(power.active.size).toBe(1);
    child?.kill();
    expect(power.active.size).toBe(0);
    void runner.shutdown();
  });
});
