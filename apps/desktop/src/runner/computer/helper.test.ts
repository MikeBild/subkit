import { describe, expect, test } from "bun:test";
import { createFakeHelper } from "./fake-helper.fixture.ts";
import { createHelperRunner, type HelperOutcome } from "./helper.ts";

const VERSION = { version: "2.6", ok: true, command: "version", data: { version: "1.3.1" } };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("helper runner against a fake helper process", () => {
  test("runs the absolute path with only the state root in the environment and cwd /", async () => {
    const fake = createFakeHelper();
    fake.script({ type: VERSION });
    const runner = createHelperRunner(fake);
    const outcome = await runner.run(
      { args: ["type", "@s1:e1", "--stdin"], stdin: "geheim 123", timeoutMs: 10_000 },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "envelope", envelope: VERSION });
    const [call] = fake.calls();
    expect(call?.argv).toEqual(["type", "@s1:e1", "--stdin"]);
    expect(call?.stdin).toBe("geheim 123");
    expect(call?.cwd).toBe("/");
    expect(call?.env.filter((name) => !name.startsWith("__CF"))).toEqual(["AGENT_DESKTOP_HOME"]);
  });

  test("closes stdin when no text is sent", async () => {
    const fake = createFakeHelper();
    fake.script({ "list-apps": { ...VERSION, command: "list-apps", data: { apps: [] } } });
    const outcome = await createHelperRunner(fake).run(
      { args: ["list-apps"], timeoutMs: 10_000 },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("envelope");
    expect(fake.calls()[0]?.stdin).toBeNull();
  });

  test("output that is no envelope is broken", async () => {
    const fake = createFakeHelper();
    fake.script({ click: "garbage" });
    const outcome = await createHelperRunner(fake).run(
      { args: ["click", "@s1:e1"], timeoutMs: 10_000 },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "broken", detail: "envelope_not_json" });
  });

  test("a stop kills the running helper at once", async () => {
    const fake = createFakeHelper();
    fake.script({ click: "hang" });
    const controller = new AbortController();
    let pid = 0;
    let spawned: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const runner = createHelperRunner(fake, {
      onSpawn: (child) => {
        pid = child;
        spawned();
      },
    });
    const running = runner.run({ args: ["click", "@s1:e1"], timeoutMs: 60_000 }, controller.signal);
    await started;
    controller.abort();
    const outcome: HelperOutcome = await running;
    expect(outcome).toEqual({ kind: "stopped" });
    expect(alive(pid)).toBe(false);
  });

  test("a helper past its time is killed and reported", async () => {
    const fake = createFakeHelper();
    fake.script({ click: "hang" });
    const outcome = await createHelperRunner(fake).run(
      { args: ["click", "@s1:e1"], timeoutMs: 0 },
      new AbortController().signal,
    );
    expect(outcome).toEqual({ kind: "timeout" });
  });

  test("nothing starts after a stop", async () => {
    const fake = createFakeHelper();
    fake.script({ click: VERSION });
    const controller = new AbortController();
    controller.abort();
    const outcome = await createHelperRunner(fake).run(
      { args: ["click"], timeoutMs: 1000 },
      controller.signal,
    );
    expect(outcome).toEqual({ kind: "stopped" });
    expect(fake.calls()).toEqual([]);
  });

  test("a missing helper binary is broken", async () => {
    const outcome = await createHelperRunner({
      path: "/nonexistent/agent-desktop",
      state_root: "/tmp",
    }).run({ args: ["version"], timeoutMs: 1000 }, new AbortController().signal);
    expect(outcome).toEqual({ kind: "broken", detail: "ENOENT" });
  });

  test("refuses relative paths", () => {
    expect(() => createHelperRunner({ path: "agent-desktop", state_root: "/tmp" })).toThrow();
    expect(() => createHelperRunner({ path: "/x/agent-desktop", state_root: "state" })).toThrow();
  });
});
