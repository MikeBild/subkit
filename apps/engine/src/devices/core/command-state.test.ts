import { describe, expect, test } from "bun:test";
import type { DeviceResult } from "@shared/device/protocol.ts";
import {
  type ClaimFacts,
  type ClosureState,
  COMMAND_LOST_AFTER_MS,
  claimVerdict,
  closureOutcome,
  DEVICE_COMMAND_STATES,
  type DeviceCommandState,
  isOpenCommand,
  type LivenessFacts,
  livenessVerdict,
  OPEN_COMMAND_STATES,
  READ_COMMAND_ATTEMPTS,
  resultOutcome,
  resultVerdict,
  retriesAfterLoss,
  stopCloses,
} from "./command-state.ts";

const NOW = 1_800_000_000_000;
const pending: ClaimFacts = { state: "pending", deadline_at_ms: NOW + 60_000, generation: 3 };
const done: DeviceResult = { status: "done", output: { ok: true }, evidence: {} };

describe("open command states", () => {
  test("every state a command can be in", () => {
    expect([...DEVICE_COMMAND_STATES]).toEqual([
      "pending",
      "claimed",
      "done",
      "refused",
      "confirmation_required",
      "failed",
      "stopped",
      "cancelled",
      "lost",
      "expired",
      "revoked",
    ]);
  });

  test("only pending and claimed are open", () => {
    expect(DEVICE_COMMAND_STATES.filter(isOpenCommand)).toEqual(["pending", "claimed"]);
    expect([...OPEN_COMMAND_STATES]).toEqual(["pending", "claimed"]);
  });
});

describe("claiming a command", () => {
  test("a pending command in time and in the current generation is claimed", () => {
    expect(claimVerdict(pending, NOW, 3)).toEqual({ ok: true });
    expect(claimVerdict(pending, NOW, 2)).toEqual({ ok: true });
    expect(claimVerdict(pending, NOW + 59_999, 3)).toEqual({ ok: true });
  });

  test("a claimed command is not claimed twice", () => {
    expect(claimVerdict({ ...pending, state: "claimed" }, NOW, 3)).toEqual({
      ok: false,
      reason: "already_claimed",
    });
  });

  test("a closed command cannot be claimed", () => {
    for (const state of ["done", "stopped", "cancelled", "lost", "expired"] as const)
      expect(claimVerdict({ ...pending, state }, NOW, 3)).toEqual({ ok: false, reason: "closed" });
  });

  test("a command of a stopped generation is closed as stopped", () => {
    expect(claimVerdict(pending, NOW, 4)).toEqual({
      ok: false,
      reason: "stopped",
      close: "stopped",
    });
  });

  test("a command that did not start by its deadline never starts", () => {
    expect(claimVerdict(pending, NOW + 60_000, 3)).toEqual({
      ok: false,
      reason: "deadline_passed",
      close: "expired",
    });
  });
});

describe("results", () => {
  test("an open command stores the first result", () => {
    expect(resultVerdict("pending", done)).toEqual({ store: true, state: "done" });
    expect(resultVerdict("claimed", { status: "stopped" })).toEqual({
      store: true,
      state: "stopped",
    });
  });

  test("a closed command keeps its result; a repeated result changes nothing", () => {
    for (const state of ["done", "failed", "cancelled", "expired"] as DeviceCommandState[])
      expect(resultVerdict(state, done)).toEqual({ store: false });
  });

  test("a lost command takes the late result the device still delivers", () => {
    expect(resultVerdict("lost", done)).toEqual({ store: true, state: "done" });
    expect(resultVerdict("lost", { status: "stopped" })).toEqual({ store: true, state: "stopped" });
  });
});

describe("stop", () => {
  test("closes the open commands of an older generation only", () => {
    expect(stopCloses({ state: "pending", generation: 3 }, 4)).toBe(true);
    expect(stopCloses({ state: "claimed", generation: 3 }, 4)).toBe(true);
    expect(stopCloses({ state: "pending", generation: 4 }, 4)).toBe(false);
    expect(stopCloses({ state: "done", generation: 3 }, 4)).toBe(false);
  });
});

describe("liveness of a command", () => {
  const claimed: LivenessFacts = {
    state: "claimed",
    deadline_at_ms: NOW + 300_000,
    claimed_at_ms: NOW,
    last_progress_at_ms: null,
    last_heartbeat_at_ms: null,
  };

  test("a pending command waits until its deadline, then expires", () => {
    const facts = { ...claimed, state: "pending" as const, claimed_at_ms: null };
    expect(livenessVerdict(facts, NOW)).toEqual({ kind: "wait", recheck_at_ms: NOW + 300_000 });
    expect(livenessVerdict(facts, NOW + 300_000)).toEqual({ kind: "expired" });
  });

  test("a claimed command with no sign of life for 45 seconds is lost", () => {
    expect(COMMAND_LOST_AFTER_MS).toBe(45_000);
    expect(livenessVerdict(claimed, NOW + 44_999)).toEqual({
      kind: "wait",
      recheck_at_ms: NOW + 45_000,
    });
    expect(livenessVerdict(claimed, NOW + 45_000)).toEqual({ kind: "lost" });
  });

  test("progress and heartbeats keep it alive", () => {
    expect(
      livenessVerdict({ ...claimed, last_progress_at_ms: NOW + 30_000 }, NOW + 60_000),
    ).toEqual({ kind: "wait", recheck_at_ms: NOW + 75_000 });
    expect(
      livenessVerdict({ ...claimed, last_heartbeat_at_ms: NOW + 40_000 }, NOW + 60_000),
    ).toEqual({ kind: "wait", recheck_at_ms: NOW + 85_000 });
  });

  test("a command never runs longer than 45 seconds past its deadline", () => {
    const late = { ...claimed, deadline_at_ms: NOW + 10_000, last_heartbeat_at_ms: NOW + 50_000 };
    expect(livenessVerdict(late, NOW + 54_999)).toEqual({
      kind: "wait",
      recheck_at_ms: NOW + 55_000,
    });
    expect(livenessVerdict(late, NOW + 55_000)).toEqual({ kind: "lost" });
  });

  test("a closed command has nothing to watch", () => {
    expect(livenessVerdict({ ...claimed, state: "done" }, NOW)).toEqual({ kind: "closed" });
  });
});

describe("retry after a lost command", () => {
  test("a read retries once; a write never", () => {
    expect(READ_COMMAND_ATTEMPTS).toBe(2);
    expect(retriesAfterLoss("read", 1)).toBe(true);
    expect(retriesAfterLoss("read", 2)).toBe(false);
    expect(retriesAfterLoss("write", 1)).toBe(false);
  });
});

describe("step outcome", () => {
  test("a result maps to the step", () => {
    expect(resultOutcome(done)).toEqual({ status: "succeeded", output: { ok: true } });
    expect(resultOutcome({ status: "refused", code: "secret_file", detail: "no" })).toEqual({
      status: "failed",
      code: "secret_file",
      message: "no",
    });
    expect(resultOutcome({ status: "failed", code: "runner_error", detail: "boom" })).toEqual({
      status: "failed",
      code: "runner_error",
      message: "boom",
    });
    expect(
      resultOutcome({
        status: "confirmation_required",
        binding_hash: "h",
        target: "t",
      }),
    ).toEqual({
      status: "failed",
      code: "confirmation_required",
      message: "This step waits for a person to confirm it. Nothing was sent or changed.",
    });
    expect(resultOutcome({ status: "stopped" })).toEqual({
      status: "aborted",
      code: "device_stopped",
      message: "Stopped on the device. Later steps won't run.",
    });
  });

  test("a closure maps to the step; a lost write says it is not repeated", () => {
    const cases: [ClosureState, "read" | "write", string, string][] = [
      ["stopped", "write", "aborted", "device_stopped"],
      ["cancelled", "write", "aborted", "cancelled"],
      ["expired", "write", "failed", "deadline_passed"],
      ["revoked", "read", "failed", "device_revoked"],
      ["lost", "write", "failed", "device_lost_during_write"],
      ["lost", "read", "failed", "device_lost"],
    ];
    for (const [closure, effect, status, code] of cases) {
      const outcome = closureOutcome(closure, effect);
      expect([outcome.status, outcome.code]).toEqual([status, code]);
      expect(outcome.message?.length ?? 0).toBeGreaterThan(0);
    }
    expect(closureOutcome("stopped", "read").message).toBe(
      "Stopped on the device. Later steps won't run.",
    );
    expect(closureOutcome("cancelled", "read").message).toBe("The run was stopped.");
    expect(closureOutcome("expired", "read").message).toBe(
      "The device did not start this step in time. Nothing was run.",
    );
    expect(closureOutcome("revoked", "read").message).toBe(
      "The device was disconnected from this workspace. Nothing more runs on it.",
    );
    expect(closureOutcome("lost", "write").message).toBe(
      "The device stopped answering during a change. It is not repeated automatically; check on the device what was done before you run it again.",
    );
    expect(closureOutcome("lost", "read").message).toBe(
      "The device stopped answering. Nothing was changed.",
    );
  });
});
