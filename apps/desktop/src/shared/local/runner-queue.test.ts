import { describe, expect, test } from "bun:test";
import { command, NOW } from "./runner-queue.fixture.ts";
import { admit, cancel, emptyQueue, finish, isStopped, stop, take } from "./runner-queue.ts";

describe("admit", () => {
  test("queues a current command in order", () => {
    let state = emptyQueue();
    state = admit(state, command("a"), NOW).state;
    state = admit(state, command("b"), NOW).state;
    expect(state.pending.map((item) => item.command_id)).toEqual(["a", "b"]);
  });

  test("refuses a command from an older generation as stopped", () => {
    const result = admit(emptyQueue(2), command("a", { generation: 1 }), NOW);
    expect(result.state.pending).toEqual([]);
    expect(result.settled?.result).toEqual({
      status: "refused",
      code: "stopped",
      detail: "The run was stopped on this device.",
    });
  });

  test("refuses a command whose deadline has passed, also exactly at the deadline", () => {
    const at = admit(emptyQueue(), command("a", { deadline_at: new Date(NOW).toISOString() }), NOW);
    expect(at.settled?.result).toMatchObject({ status: "refused", code: "deadline_passed" });
    const before = admit(
      emptyQueue(),
      command("b", { deadline_at: new Date(NOW + 1).toISOString() }),
      NOW,
    );
    expect(before.settled).toBeNull();
  });

  test("ignores a duplicate of a pending or running command", () => {
    let state = admit(emptyQueue(), command("a"), NOW).state;
    state = take(state, NOW).state;
    const again = admit(state, command("a"), NOW);
    expect(again.state).toBe(state);
    expect(again.settled).toBeNull();
    const queued = admit(state, command("b"), NOW).state;
    expect(admit(queued, command("b"), NOW).state.pending).toHaveLength(1);
  });

  test("adopts a newer generation from the server", () => {
    expect(admit(emptyQueue(1), command("a", { generation: 3 }), NOW).state.generation).toBe(3);
  });
});

describe("stop", () => {
  test("bumps the generation and refuses everything queued", () => {
    let state = admit(emptyQueue(), command("a"), NOW).state;
    state = take(state, NOW).state;
    state = admit(state, command("b"), NOW).state;
    const stopped = stop(state);
    expect(stopped.state.generation).toBe(1);
    expect(stopped.state.pending).toEqual([]);
    expect(stopped.state.running?.command_id).toBe("a");
    expect(stopped.settled).toEqual([{ command_id: "b", result: { status: "stopped" } }]);
    expect(isStopped(stopped.state, command("a"))).toBe(true);
    expect(admit(stopped.state, command("c"), NOW).settled?.result).toMatchObject({
      code: "stopped",
    });
  });
});

describe("stop with a target generation", () => {
  test("jumps to the generation main asked for", () => {
    expect(stop(emptyQueue(1), 5).state.generation).toBe(5);
    expect(stop(emptyQueue(7), 5).state.generation).toBe(8);
  });
});

describe("take", () => {
  test("starts the next command and skips expired ones", () => {
    let state = admit(
      emptyQueue(),
      command("old", { deadline_at: new Date(NOW + 10).toISOString() }),
      NOW,
    ).state;
    state = admit(state, command("new"), NOW).state;
    const next = take(state, NOW + 20);
    expect(next.command?.command_id).toBe("new");
    expect(next.settled).toEqual([
      {
        command_id: "old",
        result: {
          status: "refused",
          code: "deadline_passed",
          detail: "The command reached its deadline before it started.",
        },
      },
    ]);
  });

  test("runs one command at a time", () => {
    let state = admit(emptyQueue(), command("a"), NOW).state;
    state = admit(state, command("b"), NOW).state;
    state = take(state, NOW).state;
    const second = take(state, NOW);
    expect(second.command).toBeNull();
    expect(second.state).toBe(state);
  });

  test("returns nothing for an empty queue", () => {
    expect(take(emptyQueue(), NOW).command).toBeNull();
  });

  test("refuses queued commands of an older generation", () => {
    const state = { generation: 2, pending: [command("a", { generation: 1 })], running: null };
    const next = take(state, NOW);
    expect(next.command).toBeNull();
    expect(next.settled).toEqual([{ command_id: "a", result: { status: "stopped" } }]);
  });
});

describe("cancel and finish", () => {
  test("cancel removes a pending command as stopped", () => {
    const state = admit(emptyQueue(), command("a"), NOW).state;
    const cancelled = cancel(state, "a");
    expect(cancelled.state.pending).toEqual([]);
    expect(cancelled.settled).toEqual({ command_id: "a", result: { status: "stopped" } });
    expect(cancel(state, "missing").settled).toBeNull();
  });

  test("finish reports the real result of the running command, even after a stop", () => {
    let state = admit(emptyQueue(), command("a"), NOW).state;
    state = take(state, NOW).state;
    state = stop(state).state;
    const done = finish(state, "a", { status: "done", output: null, evidence: {} });
    expect(done.state.running).toBeNull();
    expect(done.settled?.result.status).toBe("done");
    expect(finish(done.state, "a", { status: "stopped" }).settled).toBeNull();
  });
});
